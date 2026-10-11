// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * DryDock v2 reference-position simulator (Calibrated Launch Integrity, Appendix A.2).
 *
 * The contract is never deployed. Its runtime code is placed with eth_call state overrides at every
 * address that acts in a scenario: the fresh reference buyer and each insider, liquidity owner or role
 * holder whose action is simulated. Code placed at an address acts as that address, so pools, position
 * managers, hooks and token contracts see the real owner as msg.sender and enforce their own rules.
 * Nothing is stored: each scenario runs inside a call that reverts with its result, so every scenario
 * starts from the same state at the forecast block.
 */

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IV3Pool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256, int256);
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/** Pool the token trades in. `v4` selects PoolManager swaps with `key`; otherwise `pool` is a V3 pool. */
struct Market {
    bool v4;
    address pool;
    address manager;
    PoolKey key;
    address token;
    address usdc;
    bool usdcIs0;
}

/**
 * kind 0: actor calls target with data. kind 1: actor sells its whole token balance. kind 2: actor buys
 * `amount` USDC of the token. kind 3: actor removes its own V4 position (data = abi.encode(tickLower,
 * tickUpper, liquidity, salt)) directly through the PoolManager.
 */
struct Step {
    uint8 kind;
    address actor;
    address target;
    bytes data;
    uint256 amount;
}

/** Buy `notional` USDC of the token as this contract (or, with notional 0, use the balance it already holds), run the event steps, then sell it. */
struct Scenario {
    uint256 notional;
    Step[] steps;
}

struct Outcome {
    bool bought;
    uint256 tokens; // tokens the reference purchase returned
    uint256 recovered; // USDC returned by selling them after the event; 0 when the sale reverted
    bool sold;
    uint256 stepsFailed; // bit i set when step i reverted (only the first 256 steps are tracked)
    uint256 eventUsdc; // USDC the event's sellers received in total
}

contract Simulator {
    uint160 private constant MIN_SQRT = 4295128740;
    uint160 private constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;

    error Result(Outcome outcome);

    /** Entry point, called with eth_call on the reference buyer's address. */
    function run(Market calldata market, Scenario[] calldata scenarios) external returns (Outcome[] memory outcomes) {
        outcomes = new Outcome[](scenarios.length);
        for (uint256 i = 0; i < scenarios.length; i++) {
            try this.scenario(market, scenarios[i]) {
                // scenario always reverts
            } catch (bytes memory reason) {
                if (reason.length >= 4 && bytes4(reason) == Result.selector) {
                    bytes memory body = new bytes(reason.length - 4);
                    for (uint256 j = 0; j < body.length; j++) body[j] = reason[j + 4];
                    outcomes[i] = abi.decode(body, (Outcome));
                }
            }
        }
    }

    /**
     * Code kind of each account at the call's block: 0 no code, 1 an EIP-7702 delegation (an externally
     * owned account), 2 a contract. Funding is traced only through kinds 0 and 1 (Appendix A.3).
     */
    function codeKinds(address[] calldata accounts) external view returns (uint8[] memory kinds) {
        kinds = new uint8[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            address account = accounts[i];
            uint256 size;
            bytes3 prefix;
            assembly {
                size := extcodesize(account)
                let buffer := mload(0x40)
                extcodecopy(account, buffer, 0, 3)
                prefix := and(mload(buffer), shl(232, 0xffffff))
            }
            kinds[i] = size == 0 ? 0 : (size == 23 && prefix == 0xef0100 ? 1 : 2);
        }
    }

    function scenario(Market calldata market, Scenario calldata s) external {
        require(msg.sender == address(this));
        Outcome memory out;
        uint256 before = IERC20(market.token).balanceOf(address(this));
        if (s.notional == 0) {
            // Resolution: the position bought at the forecast block is already held (set by a state override).
            out.bought = true;
            out.tokens = before;
        } else {
            try this.buy(market, s.notional) {
                out.bought = true;
            } catch {
                revert Result(out);
            }
            out.tokens = IERC20(market.token).balanceOf(address(this)) - before;
        }
        for (uint256 i = 0; i < s.steps.length; i++) {
            Step calldata step = s.steps[i];
            bool ok;
            if (step.kind == 0) {
                try Simulator(step.actor).exec(step.target, step.data) {
                    ok = true;
                } catch {}
            } else if (step.kind == 1) {
                try Simulator(step.actor).sellAll(market) returns (uint256 got) {
                    ok = true;
                    out.eventUsdc += got;
                } catch {}
            } else if (step.kind == 2) {
                try Simulator(step.actor).buy(market, step.amount) {
                    ok = true;
                } catch {}
            } else if (step.kind == 3) {
                (int24 lower, int24 upper, uint128 liquidity, bytes32 salt) = abi.decode(step.data, (int24, int24, uint128, bytes32));
                try Simulator(step.actor).withdrawV4(market, lower, upper, liquidity, salt) {
                    ok = true;
                } catch {}
            }
            if (!ok && i < 256) out.stepsFailed |= 1 << i;
        }
        if (out.tokens > 0) {
            try this.sell(market, out.tokens) returns (uint256 got) {
                out.recovered = got;
                out.sold = true;
            } catch {}
        }
        revert Result(out);
    }

    /** Called on an actor's address: perform a privileged or liquidity action as that address. */
    function exec(address target, bytes calldata data) external {
        (bool ok, bytes memory reason) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    /** Called on an actor's address: sell its entire token balance through the pool. Returns USDC received. */
    function sellAll(Market calldata market) external returns (uint256) {
        uint256 balance = IERC20(market.token).balanceOf(address(this));
        require(balance > 0, "empty");
        return _swap(market, false, balance);
    }

    /** Called on an actor's address: remove its direct V4 position and take both currencies. */
    function withdrawV4(Market calldata market, int24 lower, int24 upper, uint128 liquidity, bytes32 salt) external {
        IPoolManager(market.manager).unlock(abi.encode(uint8(1), abi.encode(market.key, lower, upper, liquidity, salt)));
    }

    function buy(Market calldata market, uint256 usdcAmount) external returns (uint256) {
        return _swap(market, true, usdcAmount);
    }

    function sell(Market calldata market, uint256 tokens) external returns (uint256) {
        return _swap(market, false, tokens);
    }

    /**
     * Value at this block of a position of `tokens` bought earlier and still held (resolution, Appendix A.5):
     * the pool as it would stand had the purchase happened is the pool now plus that purchase, so the position
     * is bought here by exact output and sold straight back. Returns the sale's proceeds; ok is false when either
     * leg reverts.
     */
    function holdValue(Market calldata market, uint256 tokens) external returns (bool ok, uint256 recovered) {
        try this.buyExact(market, tokens) {
            try this.sell(market, tokens) returns (uint256 got) {
                return (true, got);
            } catch {}
        } catch {}
        return (false, 0);
    }

    /** Exact-output purchase of `tokens`, paid in USDC. */
    function buyExact(Market calldata market, uint256 tokens) external {
        require(msg.sender == address(this));
        bool zeroForOne = market.usdcIs0;
        if (market.v4) {
            IPoolManager(market.manager).unlock(abi.encode(uint8(2), abi.encode(market.key, zeroForOne, tokens)));
        } else {
            IV3Pool(market.pool).swap(address(this), zeroForOne, -int256(tokens), zeroForOne ? MIN_SQRT : MAX_SQRT, abi.encode(market.usdc));
        }
        require(IERC20(market.token).balanceOf(address(this)) >= tokens, "fill");
    }

    /** Exact-input swap; returns the output received, measured by balance change. */
    function _swap(Market calldata market, bool buying, uint256 amountIn) internal returns (uint256) {
        address tokenOut = buying ? market.token : market.usdc;
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        // zeroForOne: input is currency0. Buying pays USDC; selling pays the token.
        bool zeroForOne = buying == market.usdcIs0;
        if (market.v4) {
            IPoolManager(market.manager).unlock(abi.encode(uint8(0), abi.encode(market.key, zeroForOne, amountIn)));
        } else {
            IV3Pool(market.pool).swap(
                address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT : MAX_SQRT, abi.encode(buying ? market.usdc : market.token)
            );
        }
        return IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    function uniswapV3SwapCallback(int256 amount0, int256 amount1, bytes calldata data) external {
        address tokenIn = abi.decode(data, (address));
        uint256 owed = uint256(amount0 > 0 ? amount0 : amount1);
        require(IERC20(tokenIn).transfer(msg.sender, owed), "pay");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (uint8 mode, bytes memory payload) = abi.decode(data, (uint8, bytes));
        IPoolManager manager = IPoolManager(msg.sender);
        if (mode == 1) {
            (PoolKey memory pk, int24 lower, int24 upper, uint128 liquidity, bytes32 salt) =
                abi.decode(payload, (PoolKey, int24, int24, uint128, bytes32));
            (int256 callerDelta,) = manager.modifyLiquidity(pk, ModifyLiquidityParams(lower, upper, -int256(uint256(liquidity)), salt), "");
            _settle(manager, pk.currency0, int128(callerDelta >> 128));
            _settle(manager, pk.currency1, int128(callerDelta));
            return "";
        }
        (PoolKey memory key, bool zeroForOne, uint256 amount) = abi.decode(payload, (PoolKey, bool, uint256));
        // Mode 0 is exact input (negative amount), mode 2 exact output (positive amount).
        int256 specified = mode == 2 ? int256(amount) : -int256(amount);
        int256 delta = manager.swap(key, SwapParams(zeroForOne, specified, zeroForOne ? MIN_SQRT : MAX_SQRT), "");
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        _settle(manager, key.currency0, amount0);
        _settle(manager, key.currency1, amount1);
        return "";
    }

    /** Negative delta: pay the PoolManager. Positive: take the output. */
    function _settle(IPoolManager manager, address currency, int128 amount) internal {
        if (amount < 0) {
            manager.sync(currency);
            require(IERC20(currency).transfer(address(manager), uint256(uint128(-amount))), "pay");
            manager.settle();
        } else if (amount > 0) {
            manager.take(currency, address(this), uint256(uint128(amount)));
        }
    }
}
