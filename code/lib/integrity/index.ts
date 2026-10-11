/**
 * DryDock v2: Calibrated Launch Integrity. One call computes the Stage 0 facts for a launch at a block.
 */
import { codeFacts, gatherEvidence, type ChainReader, type GatherOptions } from "./evidence";
import { computeFacts } from "./facts";
import type { LaunchInfo } from "./types";

export * from "./params";
export * from "./types";
export { VERSIONS } from "./versions";

/** Evidence, insider sets and facts for `launch` at `block` (a finalized block). */
export async function assessLaunch(reader: ChainReader, launch: LaunchInfo, block: number, options: GatherOptions = {}) {
  const evidence = await gatherEvidence(reader, launch, block, options);
  const owners = [...new Set(evidence.positions.map((position) => position.owner))];
  const ownerCode = new Map(await Promise.all(owners.map(async (owner) => {
    const facts = await codeFacts(reader, owner, block);
    return [owner, { implementation: facts.implementation, templateHash: facts.code === "0x" ? null : facts.templateHash, isContract: facts.code !== "0x" }] as const;
  })));
  const result = await computeFacts({ evidence, ethCall: reader.ethCall, ownerCode });
  return { evidence, ...result };
}
