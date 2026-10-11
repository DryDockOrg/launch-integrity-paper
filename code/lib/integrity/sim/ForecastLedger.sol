// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * DryDock forecast ledger (Calibrated Launch Integrity, Section 9.2 and Appendix A.3).
 *
 * One fixed committer posts the Merkle root of every forecast record issued at blocks
 * [firstBlock, lastBlock]. Roots are append-only and readable by index, so anyone can enumerate the
 * full history with eth_call alone and check that a record was committed, and when, from its
 * inclusion proof. The contract holds no funds and has no owner functions.
 */
contract ForecastLedger {
    struct Commitment {
        bytes32 root;
        uint64 firstBlock;
        uint64 lastBlock;
        uint32 records;
        uint64 committedAt;
    }

    address public immutable committer;
    Commitment[] private commitments;

    event Committed(uint256 indexed index, bytes32 root, uint64 firstBlock, uint64 lastBlock, uint32 records);

    constructor(address committer_) {
        committer = committer_;
    }

    function commit(bytes32 root, uint64 firstBlock, uint64 lastBlock, uint32 records) external {
        require(msg.sender == committer, "committer");
        require(firstBlock <= lastBlock && lastBlock < block.number, "range");
        commitments.push(Commitment(root, firstBlock, lastBlock, records, uint64(block.number)));
        emit Committed(commitments.length - 1, root, firstBlock, lastBlock, records);
    }

    function count() external view returns (uint256) {
        return commitments.length;
    }

    function commitment(uint256 index) external view returns (Commitment memory) {
        return commitments[index];
    }
}
