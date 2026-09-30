// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title OracleAttestationRegistry
/// @notice Tamper-evident public record of off-chain oracle-integrity reports.
/// @dev Each report is one monitoring observation of a single oracle pair made
///      by a monitor operator: the on-chain rate the monitor read, the
///      independent reference price it compared against, the deviation, and the
///      resulting status. Reports are keyed by keccak256(pair); the latest
///      report per pair is queryable, and every report emits a content hash
///      binding all fields so an external auditor can verify a snapshot file
///      against the chain.
///
///      The registry holds no funds and executes no asset logic. Its purpose is
///      availability and integrity of the record: once a report is on chain it
///      cannot be silently edited or deleted, and any Nibiru consumer can read
///      the latest integrity state of a feed directly from the chain the feed
///      lives on.
contract OracleAttestationRegistry {
    struct Attestation {
        string pair;
        uint64 oracleRateFixed8;
        uint64 referenceFixed8;
        int64 deviationBps;
        uint8 status;
        uint64 oracleUpdateBlock;
        uint32 collectedAtUnix;
        uint32 oracleBlock;
        bytes32 contentHash;
    }

    address public owner;

    /// @dev keccak256(pair) => latest attestation for that pair.
    mapping(bytes32 => Attestation) private _latest;

    /// @dev keccak256(pair) => total reports recorded for that pair.
    mapping(bytes32 => uint64) public reportCount;

    /// @dev content hashes already written, so duplicates are rejected.
    mapping(bytes32 => bool) public isKnownContentHash;

    event AttestationRecorded(
        bytes32 indexed pairId,
        string pair,
        uint64 oracleRateFixed8,
        uint64 referenceFixed8,
        int64 deviationBps,
        uint8 status,
        uint64 oracleUpdateBlock,
        uint32 collectedAtUnix,
        uint32 oracleBlock,
        bytes32 contentHash
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error EmptyPair();
    error PairIdMismatch(bytes32 supplied, bytes32 expected);
    error ZeroOracleRate();
    error InvalidStatus(uint8 status);
    error DuplicateContent();
    error NoAttestation(bytes32 pairId);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /// @notice Transfer ownership of the registry.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Record one integrity report for a pair.
    /// @param pairId keccak256 of the pair string, supplied by the caller and
    ///        validated against the pair to prevent mis-keyed entries.
    /// @dev Status codes: 0 ok, 1 warning, 2 critical, 3 stale, 4 unavailable.
    ///      Prices are fixed-point 1e8. Rates must be non-zero for a meaningful
    ///      report; a zero oracle rate is a failed read and is rejected. Each
    ///      rejected condition has its own error so a failing writer can tell
    ///      what was wrong from the revert data alone.
    function record(
        bytes32 pairId,
        string calldata pair,
        uint64 oracleRateFixed8,
        uint64 referenceFixed8,
        int64 deviationBps,
        uint8 status,
        uint64 oracleUpdateBlock,
        uint32 collectedAtUnix,
        uint32 oracleBlock
    ) external onlyOwner {
        if (bytes(pair).length == 0) revert EmptyPair();
        bytes32 expected = keccak256(bytes(pair));
        if (pairId != expected) revert PairIdMismatch(pairId, expected);
        if (oracleRateFixed8 == 0) revert ZeroOracleRate();
        if (status > 4) revert InvalidStatus(status);

        bytes32 contentHash = keccak256(
            abi.encode(
                pair,
                oracleRateFixed8,
                referenceFixed8,
                deviationBps,
                status,
                oracleUpdateBlock,
                collectedAtUnix,
                oracleBlock
            )
        );
        if (isKnownContentHash[contentHash]) revert DuplicateContent();
        isKnownContentHash[contentHash] = true;

        _latest[pairId] = Attestation({
            pair: pair,
            oracleRateFixed8: oracleRateFixed8,
            referenceFixed8: referenceFixed8,
            deviationBps: deviationBps,
            status: status,
            oracleUpdateBlock: oracleUpdateBlock,
            collectedAtUnix: collectedAtUnix,
            oracleBlock: oracleBlock,
            contentHash: contentHash
        });
        reportCount[pairId] += 1;

        emit AttestationRecorded(
            pairId,
            pair,
            oracleRateFixed8,
            referenceFixed8,
            deviationBps,
            status,
            oracleUpdateBlock,
            collectedAtUnix,
            oracleBlock,
            contentHash
        );
    }

    /// @notice Latest attestation for a pair. Reverts if none exists.
    function getAttestation(bytes32 pairId) external view returns (Attestation memory) {
        Attestation storage a = _latest[pairId];
        if (a.oracleRateFixed8 == 0) revert NoAttestation(pairId);
        return a;
    }

    /// @notice Convenience lookup by pair string. Returns a zero struct when
    ///         absent; callers should check `found`.
    function lookup(string calldata pair)
        external
        view
        returns (bool found, Attestation memory attestation)
    {
        bytes32 id = keccak256(bytes(pair));
        Attestation storage a = _latest[id];
        if (a.oracleRateFixed8 == 0) {
            return (false, attestation);
        }
        return (true, a);
    }
}
