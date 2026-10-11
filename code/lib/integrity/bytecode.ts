import { keccak256 } from "viem";

/** Implementation address of an EIP-1167 minimal proxy, or null. */
export function cloneTarget(code: string): string | null {
  const body = code.toLowerCase();
  const match = body.match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/);
  return match ? `0x${match[1]}` : null;
}

/**
 * Hash of runtime code with every PUSH20 and PUSH32 immediate zeroed. Constructor immutables are inlined
 * as such immediates, so all instances of one template share this hash while differing in their per-launch
 * constants. Template identity, not constant values, is what the registry matches on.
 */
export function templateHash(code: string): string {
  const bytes = hexBytes(code);
  for (let index = 0; index < bytes.length; index++) {
    const op = bytes[index];
    if (op >= 0x60 && op <= 0x7f) {
      const width = op - 0x5f;
      if (width === 20 || width === 32) bytes.fill(0, index + 1, Math.min(bytes.length, index + 1 + width));
      index += width;
    }
  }
  return keccak256(bytes);
}

/** Function selectors a contract dispatches on (PUSH4 followed by EQ in the dispatcher), and the opcodes that matter for custody. */
export function codeFacts(code: string) {
  const bytes = hexBytes(code);
  const pushed = new Set<string>();
  const dispatched = new Set<string>();
  let delegatecall = false, selfdestruct = false, call = false;
  for (let index = 0; index < bytes.length; index++) {
    const op = bytes[index];
    if (op === 0x63) {
      const selector = Array.from(bytes.subarray(index + 1, index + 5), (byte) => byte.toString(16).padStart(2, "0")).join("");
      pushed.add(selector);
      // Solidity dispatchers compare with DUP1 PUSH4 x EQ (or PUSH4 x DUP2 EQ).
      if (bytes[index + 5] === 0x14 || (bytes[index + 5] === 0x81 && bytes[index + 6] === 0x14) || (bytes[index - 1] === 0x80 && bytes[index + 5] === 0x14)) dispatched.add(selector);
    }
    if (op === 0xf4) delegatecall = true;
    if (op === 0xff) selfdestruct = true;
    if (op === 0xf1) call = true;
    if (op >= 0x60 && op <= 0x7f) index += op - 0x5f;
  }
  return { pushed, dispatched, delegatecall, selfdestruct, call };
}

function hexBytes(code: string) {
  const clean = code.startsWith("0x") ? code.slice(2) : code;
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
