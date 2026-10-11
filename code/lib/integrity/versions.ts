import { keccak256, toBytes, type Hex } from "viem";
import { canonicalJson, PARAMS, SPEC_VERSION } from "./params";
import { REGISTRY } from "./registry";
import { SPEC_TEXT_HASH } from "./spec-hash";

/** Hashes every forecast record carries (Appendix A.3): the normative text, the parameters and the registry. */
export const VERSIONS: { spec: Hex; params: Hex; registry: Hex } = {
  spec: keccak256(toBytes(`${SPEC_VERSION}:${SPEC_TEXT_HASH}`)),
  params: keccak256(toBytes(canonicalJson(PARAMS))),
  registry: keccak256(toBytes(canonicalJson(REGISTRY))),
};
