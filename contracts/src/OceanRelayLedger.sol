// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Numeric values are the C-14 enum. `Expired` is reached only through `markExpired`.
enum OfferState {
    None,
    Published,
    Paused,
    Withdrawn,
    Expired
}

/// @dev Numeric values are the C-14 enum. `Cancelled` is reached only through `recordCancellation`.
enum Fulfilment {
    None,
    Requested,
    Accepted,
    CarrierPending,
    CarrierConfirmed,
    Rejected,
    Rolled,
    Completed,
    Cancelled
}

/// @notice On-chain lifecycle record. Commitments are hashes. The contract holds no funds and stores no prices.
/// @dev There is no `receive` and no `fallback`, so a transfer of ETH or an unknown selector reverts.
contract OceanRelayLedger is Ownable2Step, Pausable, EIP712 {
    string public constant BINDING_TYPESTRING = "Binding(bytes32 companyKey,address wallet,uint64 deadline)";
    string public constant PUBLISH_TYPESTRING =
        "Publish(bytes32 offerId,bytes32 commitment,uint64 expiresAt,uint64 deadline)";
    string public constant VERSION_TYPESTRING =
        "Version(bytes32 offerId,uint32 version,bytes32 commitment,uint64 expiresAt,uint64 deadline)";
    string public constant OFFER_STATE_TYPESTRING =
        "OfferState(bytes32 offerId,uint8 state,uint32 seq,uint64 deadline)";
    string public constant REQUEST_TYPESTRING =
        "Request(bytes32 requestId,bytes32 offerId,uint32 version,uint64 deadline)";
    string public constant ACCEPTANCE_TYPESTRING =
        "Acceptance(bytes32 requestId,uint32 counter,bytes32 termsCommitment,uint64 deadline)";
    string public constant STATUS_TYPESTRING = "Status(bytes32 requestId,uint8 status,uint32 seq,uint64 deadline)";
    string public constant CANCELLATION_TYPESTRING = "Cancellation(bytes32 requestId,uint64 deadline)";

    bytes32 public constant BINDING_TYPEHASH = keccak256(bytes(BINDING_TYPESTRING));
    bytes32 public constant PUBLISH_TYPEHASH = keccak256(bytes(PUBLISH_TYPESTRING));
    bytes32 public constant VERSION_TYPEHASH = keccak256(bytes(VERSION_TYPESTRING));
    bytes32 public constant OFFER_STATE_TYPEHASH = keccak256(bytes(OFFER_STATE_TYPESTRING));
    bytes32 public constant REQUEST_TYPEHASH = keccak256(bytes(REQUEST_TYPESTRING));
    bytes32 public constant ACCEPTANCE_TYPEHASH = keccak256(bytes(ACCEPTANCE_TYPESTRING));
    bytes32 public constant STATUS_TYPEHASH = keccak256(bytes(STATUS_TYPESTRING));
    bytes32 public constant CANCELLATION_TYPEHASH = keccak256(bytes(CANCELLATION_TYPESTRING));

    struct Offer {
        bytes32 companyKey;
        bytes32 commitment;
        uint64 expiresAt;
        uint32 version;
        uint32 stateSeq;
        OfferState state;
        bool exists;
    }

    struct Request {
        bytes32 offerId;
        bytes32 buyerCompany;
        bytes32 termsCommitment;
        uint32 version;
        uint32 statusSeq;
        Fulfilment status;
        bool exists;
    }

    address public relayer;
    address public registrar;

    mapping(address => bytes32) public walletCompany;
    mapping(address => bool) public operators;
    mapping(bytes32 => bool) public usedDigests;
    mapping(bytes32 => Offer) private _offers;
    mapping(bytes32 => Request) private _requests;

    error ZeroAddress();
    error RelayerRegistrarConflict();
    error NotRelayer(address caller);
    error InvalidSignature();
    error DeadlineExpired(uint64 deadline, uint256 nowTs);
    error DigestUsed(bytes32 digest);
    error ZeroCompanyKey();
    error WalletAlreadyBound(address wallet, bytes32 companyKey);
    error NotRegistrar(address signer);
    error SignerMismatch(address expected, address recovered);
    error DuplicateSigner();
    error ZeroOfferId();
    error DuplicateOffer(bytes32 offerId);
    error ZeroCommitment();
    error ExpiryNotFuture(uint64 expiresAt);
    error WalletNotBound(address wallet);
    error NotOfferOwner(bytes32 offerId, bytes32 companyKey);
    error BadOfferState(uint8 state);
    error BadVersion(uint32 expected, uint32 actual);
    error BadSequence(uint32 expected, uint32 actual);
    error NotYetExpired(bytes32 offerId, uint64 expiresAt);
    error OfferMissing(bytes32 offerId);
    error ZeroRequestId();
    error DuplicateRequest(bytes32 requestId);
    error RequestMissing(bytes32 requestId);
    error SameCompanyRequest(bytes32 companyKey);
    error OfferNotPublished(uint8 state);
    error StaleVersion(uint32 current, uint32 pinned);
    error BadFulfilment(uint8 status);
    error NotParty(address signer);
    error SameCompanySignatures();
    error NotCancellable(uint8 status);

    event RelayerUpdated(address indexed relayer);
    event RegistrarUpdated(address indexed registrar);
    event OperatorUpdated(address indexed account, bool allowed);
    event WalletRevoked(address indexed wallet, bytes32 companyKey);
    event WalletBound(bytes32 indexed companyKey, address indexed wallet);
    event OfferPublished(
        bytes32 indexed offerId,
        bytes32 indexed companyKey,
        address indexed signer,
        uint32 version,
        bytes32 commitment,
        uint64 expiresAt
    );
    event VersionPublished(
        bytes32 indexed offerId, uint32 version, bytes32 commitment, uint64 expiresAt, address signer
    );
    event OfferStateSet(bytes32 indexed offerId, uint8 state, uint32 seq, address signer);
    event OfferExpired(bytes32 indexed offerId);
    event RequestRecorded(
        bytes32 indexed requestId, bytes32 indexed offerId, bytes32 indexed buyerCompany, uint32 version, address signer
    );
    event AcceptanceRecorded(
        bytes32 indexed requestId, uint32 counter, bytes32 termsCommitment, address signerA, address signerB
    );
    event StatusRecorded(bytes32 indexed requestId, uint8 status, uint32 seq, address signer);
    event CancellationRecorded(bytes32 indexed requestId, address signerA, address signerB);

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer(msg.sender);
        _;
    }

    constructor(address initialRelayer, address initialRegistrar) Ownable(msg.sender) EIP712("OceanRelay", "1") {
        if (initialRelayer == address(0) || initialRegistrar == address(0)) revert ZeroAddress();
        if (initialRelayer == initialRegistrar) revert RelayerRegistrarConflict();
        relayer = initialRelayer;
        registrar = initialRegistrar;
        emit RelayerUpdated(initialRelayer);
        emit RegistrarUpdated(initialRegistrar);
    }

    function setRelayer(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        if (next == registrar) revert RelayerRegistrarConflict();
        relayer = next;
        emit RelayerUpdated(next);
    }

    function setRegistrar(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        if (next == relayer) revert RelayerRegistrarConflict();
        registrar = next;
        emit RegistrarUpdated(next);
    }

    function setOperator(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        operators[account] = allowed;
        emit OperatorUpdated(account, allowed);
    }

    function revokeWallet(address wallet) external onlyOwner {
        bytes32 companyKey = walletCompany[wallet];
        if (companyKey == bytes32(0)) revert WalletNotBound(wallet);
        delete walletCompany[wallet];
        emit WalletRevoked(wallet, companyKey);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function bindWallet(
        bytes32 companyKey,
        address wallet,
        uint64 deadline,
        bytes calldata walletSig,
        bytes calldata registrarSig
    ) external onlyRelayer whenNotPaused {
        if (companyKey == bytes32(0)) revert ZeroCompanyKey();
        if (wallet == address(0)) revert ZeroAddress();
        _requireDeadline(deadline);
        bytes32 digest = _hashTypedDataV4(_structHashBinding(companyKey, wallet, deadline));
        _requireUnused(digest);
        address walletSigner = _recover(digest, walletSig);
        address registrarSigner = _recover(digest, registrarSig);
        if (walletSigner != wallet) revert SignerMismatch(wallet, walletSigner);
        if (registrarSigner != registrar) revert NotRegistrar(registrarSigner);
        if (walletSigner == registrarSigner) revert DuplicateSigner();
        bytes32 existing = walletCompany[wallet];
        if (existing != bytes32(0)) revert WalletAlreadyBound(wallet, existing);
        _consume(digest);
        walletCompany[wallet] = companyKey;
        emit WalletBound(companyKey, wallet);
    }

    function publishOffer(bytes32 offerId, bytes32 commitment, uint64 expiresAt, uint64 deadline, bytes calldata sig)
        external
        onlyRelayer
        whenNotPaused
    {
        _requireDeadline(deadline);
        if (offerId == bytes32(0)) revert ZeroOfferId();
        if (commitment == bytes32(0)) revert ZeroCommitment();
        _requireFutureExpiry(expiresAt);
        bytes32 digest = _hashTypedDataV4(_structHashPublish(offerId, commitment, expiresAt, deadline));
        _requireUnused(digest);
        address signer = _recover(digest, sig);
        bytes32 companyKey = _boundCompany(signer);
        if (_offers[offerId].exists) revert DuplicateOffer(offerId);
        _consume(digest);
        _offers[offerId] = Offer({
            companyKey: companyKey,
            commitment: commitment,
            expiresAt: expiresAt,
            version: 1,
            stateSeq: 0,
            state: OfferState.Published,
            exists: true
        });
        emit OfferPublished(offerId, companyKey, signer, 1, commitment, expiresAt);
    }

    function publishVersion(
        bytes32 offerId,
        uint32 version,
        bytes32 commitment,
        uint64 expiresAt,
        uint64 deadline,
        bytes calldata sig
    ) external onlyRelayer whenNotPaused {
        _requireDeadline(deadline);
        if (commitment == bytes32(0)) revert ZeroCommitment();
        _requireFutureExpiry(expiresAt);
        bytes32 digest = _hashTypedDataV4(_structHashVersion(offerId, version, commitment, expiresAt, deadline));
        _requireUnused(digest);
        address signer = _recover(digest, sig);
        bytes32 companyKey = _boundCompany(signer);
        Offer storage offer = _offers[offerId];
        if (!offer.exists) revert OfferMissing(offerId);
        if (offer.companyKey != companyKey) revert NotOfferOwner(offerId, companyKey);
        if (offer.state != OfferState.Published && offer.state != OfferState.Paused) {
            revert BadOfferState(uint8(offer.state));
        }
        uint32 expected = offer.version + 1;
        if (version != expected) revert BadVersion(expected, version);
        _consume(digest);
        offer.version = version;
        offer.commitment = commitment;
        offer.expiresAt = expiresAt;
        emit VersionPublished(offerId, version, commitment, expiresAt, signer);
    }

    function setOfferState(bytes32 offerId, uint8 state, uint32 seq, uint64 deadline, bytes calldata sig)
        external
        onlyRelayer
        whenNotPaused
    {
        _requireDeadline(deadline);
        bytes32 digest = _hashTypedDataV4(_structHashOfferState(offerId, state, seq, deadline));
        _requireUnused(digest);
        address signer = _recover(digest, sig);
        bytes32 companyKey = _boundCompany(signer);
        Offer storage offer = _offers[offerId];
        if (!offer.exists) revert OfferMissing(offerId);
        if (offer.companyKey != companyKey) revert NotOfferOwner(offerId, companyKey);
        if (seq != offer.stateSeq) revert BadSequence(offer.stateSeq, seq);
        if (!_offerMoveAllowed(offer.state, state)) revert BadOfferState(state);
        _consume(digest);
        offer.state = OfferState(state);
        offer.stateSeq = seq + 1;
        emit OfferStateSet(offerId, state, seq, signer);
    }

    /// @notice Relayer-only. No user signature. Succeeds only after the stored `expiresAt`.
    function markExpired(bytes32 offerId) external onlyRelayer whenNotPaused {
        Offer storage offer = _offers[offerId];
        if (!offer.exists) revert OfferMissing(offerId);
        if (block.timestamp <= offer.expiresAt) revert NotYetExpired(offerId, offer.expiresAt);
        if (offer.state != OfferState.Published && offer.state != OfferState.Paused) {
            revert BadOfferState(uint8(offer.state));
        }
        offer.state = OfferState.Expired;
        emit OfferExpired(offerId);
    }

    function recordRequest(bytes32 requestId, bytes32 offerId, uint32 version, uint64 deadline, bytes calldata sig)
        external
        onlyRelayer
        whenNotPaused
    {
        _requireDeadline(deadline);
        if (requestId == bytes32(0)) revert ZeroRequestId();
        bytes32 digest = _hashTypedDataV4(_structHashRequest(requestId, offerId, version, deadline));
        _requireUnused(digest);
        address signer = _recover(digest, sig);
        bytes32 buyerCompany = _boundCompany(signer);
        Offer storage offer = _offers[offerId];
        if (!offer.exists) revert OfferMissing(offerId);
        if (offer.state != OfferState.Published) revert OfferNotPublished(uint8(offer.state));
        if (version != offer.version) revert StaleVersion(offer.version, version);
        if (buyerCompany == offer.companyKey) revert SameCompanyRequest(buyerCompany);
        if (_requests[requestId].exists) revert DuplicateRequest(requestId);
        _consume(digest);
        _requests[requestId] = Request({
            offerId: offerId,
            buyerCompany: buyerCompany,
            termsCommitment: bytes32(0),
            version: version,
            statusSeq: 0,
            status: Fulfilment.Requested,
            exists: true
        });
        emit RequestRecorded(requestId, offerId, buyerCompany, version, signer);
    }

    function recordAcceptance(
        bytes32 requestId,
        uint32 counter,
        bytes32 termsCommitment,
        uint64 deadline,
        bytes calldata sigA,
        bytes calldata sigB
    ) external onlyRelayer whenNotPaused {
        _requireDeadline(deadline);
        if (termsCommitment == bytes32(0)) revert ZeroCommitment();
        bytes32 digest = _hashTypedDataV4(_structHashAcceptance(requestId, counter, termsCommitment, deadline));
        _requireUnused(digest);
        address signerA = _recover(digest, sigA);
        address signerB = _recover(digest, sigB);
        if (signerA == signerB) revert DuplicateSigner();
        Request storage request = _requests[requestId];
        if (!request.exists) revert RequestMissing(requestId);
        if (request.status != Fulfilment.Requested) revert BadFulfilment(uint8(request.status));
        Offer storage offer = _offers[request.offerId];
        if (offer.state != OfferState.Published) revert OfferNotPublished(uint8(offer.state));
        if (offer.version != request.version) revert StaleVersion(offer.version, request.version);
        _requireBothCompanies(signerA, signerB, offer.companyKey, request.buyerCompany);
        _consume(digest);
        request.status = Fulfilment.Accepted;
        request.termsCommitment = termsCommitment;
        emit AcceptanceRecorded(requestId, counter, termsCommitment, signerA, signerB);
    }

    function recordStatus(bytes32 requestId, uint8 status, uint32 seq, uint64 deadline, bytes calldata sig)
        external
        onlyRelayer
        whenNotPaused
    {
        _requireDeadline(deadline);
        bytes32 digest = _hashTypedDataV4(_structHashStatus(requestId, status, seq, deadline));
        _requireUnused(digest);
        address signer = _recover(digest, sig);
        Request storage request = _requests[requestId];
        if (!request.exists) revert RequestMissing(requestId);
        if (seq != request.statusSeq) revert BadSequence(request.statusSeq, seq);
        if (!statusMoveAllowed(uint8(request.status), status)) revert BadFulfilment(status);
        Offer storage offer = _offers[request.offerId];
        bytes32 company = walletCompany[signer];
        bool party = company != bytes32(0) && (company == offer.companyKey || company == request.buyerCompany);
        if (!party && !operators[signer]) revert NotParty(signer);
        _consume(digest);
        request.status = Fulfilment(status);
        request.statusSeq = seq + 1;
        emit StatusRecorded(requestId, status, seq, signer);
    }

    function recordCancellation(bytes32 requestId, uint64 deadline, bytes calldata sigA, bytes calldata sigB)
        external
        onlyRelayer
        whenNotPaused
    {
        _requireDeadline(deadline);
        bytes32 digest = _hashTypedDataV4(_structHashCancellation(requestId, deadline));
        _requireUnused(digest);
        address signerA = _recover(digest, sigA);
        address signerB = _recover(digest, sigB);
        if (signerA == signerB) revert DuplicateSigner();
        Request storage request = _requests[requestId];
        if (!request.exists) revert RequestMissing(requestId);
        if (!_cancellable(request.status)) revert NotCancellable(uint8(request.status));
        Offer storage offer = _offers[request.offerId];
        _requireBothCompanies(signerA, signerB, offer.companyKey, request.buyerCompany);
        _consume(digest);
        request.status = Fulfilment.Cancelled;
        emit CancellationRecorded(requestId, signerA, signerB);
    }

    /// @notice D-20 carrier-status moves. Every other pair is refused.
    function statusMoveAllowed(uint8 from, uint8 to) public pure returns (bool) {
        if (from == uint8(Fulfilment.Accepted)) {
            return to == uint8(Fulfilment.CarrierPending) || to == uint8(Fulfilment.CarrierConfirmed);
        }
        if (from == uint8(Fulfilment.CarrierPending)) {
            return to == uint8(Fulfilment.CarrierConfirmed) || to == uint8(Fulfilment.Rejected);
        }
        if (from == uint8(Fulfilment.CarrierConfirmed)) {
            return
                to == uint8(Fulfilment.Rolled) || to == uint8(Fulfilment.Completed) || to == uint8(Fulfilment.Rejected);
        }
        if (from == uint8(Fulfilment.Rolled)) {
            return to == uint8(Fulfilment.CarrierPending) || to == uint8(Fulfilment.CarrierConfirmed);
        }
        return false;
    }

    function getOffer(bytes32 offerId)
        external
        view
        returns (
            bytes32 companyKey,
            uint32 version,
            uint32 stateSeq,
            OfferState state,
            uint64 expiresAt,
            bytes32 commitment
        )
    {
        Offer storage offer = _offers[offerId];
        return (offer.companyKey, offer.version, offer.stateSeq, offer.state, offer.expiresAt, offer.commitment);
    }

    function getRequest(bytes32 requestId)
        external
        view
        returns (
            bytes32 offerId,
            bytes32 buyerCompany,
            uint32 version,
            uint32 statusSeq,
            Fulfilment status,
            bytes32 termsCommitment
        )
    {
        Request storage request = _requests[requestId];
        return (
            request.offerId,
            request.buyerCompany,
            request.version,
            request.statusSeq,
            request.status,
            request.termsCommitment
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function structHashBinding(bytes32 companyKey, address wallet, uint64 deadline) external pure returns (bytes32) {
        return _structHashBinding(companyKey, wallet, deadline);
    }

    function hashBinding(bytes32 companyKey, address wallet, uint64 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(_structHashBinding(companyKey, wallet, deadline));
    }

    function structHashPublish(bytes32 offerId, bytes32 commitment, uint64 expiresAt, uint64 deadline)
        external
        pure
        returns (bytes32)
    {
        return _structHashPublish(offerId, commitment, expiresAt, deadline);
    }

    function hashPublish(bytes32 offerId, bytes32 commitment, uint64 expiresAt, uint64 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(_structHashPublish(offerId, commitment, expiresAt, deadline));
    }

    function structHashVersion(bytes32 offerId, uint32 version, bytes32 commitment, uint64 expiresAt, uint64 deadline)
        external
        pure
        returns (bytes32)
    {
        return _structHashVersion(offerId, version, commitment, expiresAt, deadline);
    }

    function hashVersion(bytes32 offerId, uint32 version, bytes32 commitment, uint64 expiresAt, uint64 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(_structHashVersion(offerId, version, commitment, expiresAt, deadline));
    }

    function structHashOfferState(bytes32 offerId, uint8 state, uint32 seq, uint64 deadline)
        external
        pure
        returns (bytes32)
    {
        return _structHashOfferState(offerId, state, seq, deadline);
    }

    function hashOfferState(bytes32 offerId, uint8 state, uint32 seq, uint64 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(_structHashOfferState(offerId, state, seq, deadline));
    }

    function structHashRequest(bytes32 requestId, bytes32 offerId, uint32 version, uint64 deadline)
        external
        pure
        returns (bytes32)
    {
        return _structHashRequest(requestId, offerId, version, deadline);
    }

    function hashRequest(bytes32 requestId, bytes32 offerId, uint32 version, uint64 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(_structHashRequest(requestId, offerId, version, deadline));
    }

    function structHashAcceptance(bytes32 requestId, uint32 counter, bytes32 termsCommitment, uint64 deadline)
        external
        pure
        returns (bytes32)
    {
        return _structHashAcceptance(requestId, counter, termsCommitment, deadline);
    }

    function hashAcceptance(bytes32 requestId, uint32 counter, bytes32 termsCommitment, uint64 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(_structHashAcceptance(requestId, counter, termsCommitment, deadline));
    }

    function structHashStatus(bytes32 requestId, uint8 status, uint32 seq, uint64 deadline)
        external
        pure
        returns (bytes32)
    {
        return _structHashStatus(requestId, status, seq, deadline);
    }

    function hashStatus(bytes32 requestId, uint8 status, uint32 seq, uint64 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(_structHashStatus(requestId, status, seq, deadline));
    }

    function structHashCancellation(bytes32 requestId, uint64 deadline) external pure returns (bytes32) {
        return _structHashCancellation(requestId, deadline);
    }

    function hashCancellation(bytes32 requestId, uint64 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(_structHashCancellation(requestId, deadline));
    }

    function _structHashBinding(bytes32 companyKey, address wallet, uint64 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(BINDING_TYPEHASH, companyKey, wallet, deadline));
    }

    function _structHashPublish(bytes32 offerId, bytes32 commitment, uint64 expiresAt, uint64 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(PUBLISH_TYPEHASH, offerId, commitment, expiresAt, deadline));
    }

    function _structHashVersion(bytes32 offerId, uint32 version, bytes32 commitment, uint64 expiresAt, uint64 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(VERSION_TYPEHASH, offerId, version, commitment, expiresAt, deadline));
    }

    function _structHashOfferState(bytes32 offerId, uint8 state, uint32 seq, uint64 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(OFFER_STATE_TYPEHASH, offerId, state, seq, deadline));
    }

    function _structHashRequest(bytes32 requestId, bytes32 offerId, uint32 version, uint64 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(REQUEST_TYPEHASH, requestId, offerId, version, deadline));
    }

    function _structHashAcceptance(bytes32 requestId, uint32 counter, bytes32 termsCommitment, uint64 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(ACCEPTANCE_TYPEHASH, requestId, counter, termsCommitment, deadline));
    }

    function _structHashStatus(bytes32 requestId, uint8 status, uint32 seq, uint64 deadline)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(STATUS_TYPEHASH, requestId, status, seq, deadline));
    }

    function _structHashCancellation(bytes32 requestId, uint64 deadline) internal pure returns (bytes32) {
        return keccak256(abi.encode(CANCELLATION_TYPEHASH, requestId, deadline));
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered == address(0)) revert InvalidSignature();
        signer = recovered;
    }

    function _requireDeadline(uint64 deadline) internal view {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
    }

    function _requireFutureExpiry(uint64 expiresAt) internal view {
        if (expiresAt <= block.timestamp) revert ExpiryNotFuture(expiresAt);
    }

    function _requireUnused(bytes32 digest) internal view {
        if (usedDigests[digest]) revert DigestUsed(digest);
    }

    function _consume(bytes32 digest) internal {
        usedDigests[digest] = true;
    }

    function _boundCompany(address wallet) internal view returns (bytes32 companyKey) {
        companyKey = walletCompany[wallet];
        if (companyKey == bytes32(0)) revert WalletNotBound(wallet);
    }

    function _requireBothCompanies(address a, address b, bytes32 seller, bytes32 buyer) internal view {
        bytes32 companyA = _boundCompany(a);
        bytes32 companyB = _boundCompany(b);
        if (companyA == companyB) revert SameCompanySignatures();
        bool matches = (companyA == seller && companyB == buyer) || (companyA == buyer && companyB == seller);
        if (!matches) revert NotParty(a);
    }

    function _offerMoveAllowed(OfferState from, uint8 to) internal pure returns (bool) {
        if (from == OfferState.Published && to == uint8(OfferState.Paused)) return true;
        if (from == OfferState.Paused && to == uint8(OfferState.Published)) return true;
        if ((from == OfferState.Published || from == OfferState.Paused) && to == uint8(OfferState.Withdrawn)) {
            return true;
        }
        return false;
    }

    function _cancellable(Fulfilment status) internal pure returns (bool) {
        return status == Fulfilment.Accepted || status == Fulfilment.CarrierPending
            || status == Fulfilment.CarrierConfirmed || status == Fulfilment.Rejected || status == Fulfilment.Rolled;
    }
}
