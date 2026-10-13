// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * DryDock forecast ledger (Calibrated Launch Integrity, Section 10.2 and Appendix A.4).
 *
 * One fixed committer posts the Merkle root of every batch of forecast records, in strict sequence. Nothing per
 * batch is stored: the Committed event carries the root, its batch number, the forecast blocks it covers and
 * its record count, and the transaction receipt gives the block in which it landed. Receipts and logs are
 * permanent chain data, so a verifier reads every commitment from this contract's events and can check that
 * the sequence has no gap. The only state is the next expected batch number. The contract holds no funds and
 * has no owner functions.
 */
contract ForecastLedger {
    address public immutable committer;
    /// Batch number the next commitment must carry; batches start at 1.
    uint64 public next = 1;

    event Committed(uint64 indexed seq, bytes32 root, uint64 firstBlock, uint64 lastBlock, uint32 records);

    constructor(address committer_) {
        committer = committer_;
    }

    function commit(uint64 seq, bytes32 root, uint64 firstBlock, uint64 lastBlock, uint32 records) external {
        require(msg.sender == committer, "committer");
        require(seq == next, "sequence");
        require(firstBlock <= lastBlock && lastBlock < block.number, "range");
        next = seq + 1;
        emit Committed(seq, root, firstBlock, lastBlock, records);
    }
}
