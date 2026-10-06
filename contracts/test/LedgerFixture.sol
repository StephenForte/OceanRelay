// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OceanRelayLedger, OfferState, Fulfilment} from "../src/OceanRelayLedger.sol";

/// @dev Private keys in this file are test constants. They are not production keys.
abstract contract LedgerFixture is Test {
    uint256 internal constant RELAYER_PK = 0xB22;
    uint256 internal constant REGISTRAR_PK = 0xC33;
    uint256 internal constant SELLER_PK = 0xD44;
    uint256 internal constant SELLER2_PK = 0xD45;
    uint256 internal constant BUYER_PK = 0xE55;
    uint256 internal constant BUYER2_PK = 0xE56;
    uint256 internal constant OPERATOR_PK = 0xF66;
    uint256 internal constant OTHER_PK = 0x177;
    uint256 internal constant STRANGER_PK = 0x188;

    bytes32 internal constant SELLER_CO = bytes32(uint256(0x11));
    bytes32 internal constant BUYER_CO = bytes32(uint256(0x22));
    bytes32 internal constant OTHER_CO = bytes32(uint256(0x33));

    OceanRelayLedger internal ledger;
    address internal relayer;
    address internal registrar;
    address internal seller;
    address internal seller2;
    address internal buyer;
    address internal buyer2;
    address internal operator;
    address internal other;
    address internal stranger;

    uint256 internal idCursor = 1;

    function setUp() public virtual {
        relayer = vm.addr(RELAYER_PK);
        registrar = vm.addr(REGISTRAR_PK);
        seller = vm.addr(SELLER_PK);
        seller2 = vm.addr(SELLER2_PK);
        buyer = vm.addr(BUYER_PK);
        buyer2 = vm.addr(BUYER2_PK);
        operator = vm.addr(OPERATOR_PK);
        other = vm.addr(OTHER_PK);
        stranger = vm.addr(STRANGER_PK);
        ledger = new OceanRelayLedger(relayer, registrar);
    }

    function _deadline() internal view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }

    function _expiry() internal view returns (uint64) {
        return uint64(block.timestamp + 7 days);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _id() internal returns (bytes32) {
        return bytes32(idCursor++);
    }

    function _bind(uint256 pk, bytes32 companyKey) internal {
        _bindAt(pk, companyKey, _deadline());
    }

    function _bindAt(uint256 pk, bytes32 companyKey, uint64 deadline) internal {
        address wallet = vm.addr(pk);
        bytes32 digest = ledger.hashBinding(companyKey, wallet, deadline);
        vm.prank(relayer);
        ledger.bindWallet(companyKey, wallet, deadline, _sign(pk, digest), _sign(REGISTRAR_PK, digest));
    }

    function _publish(uint256 pk, bytes32 offerId, bytes32 commitment, uint64 expiresAt) internal {
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashPublish(offerId, commitment, expiresAt, deadline);
        vm.prank(relayer);
        ledger.publishOffer(offerId, commitment, expiresAt, deadline, _sign(pk, digest));
    }

    function _publishVersion(uint256 pk, bytes32 offerId, uint32 version, bytes32 commitment, uint64 expiresAt)
        internal
    {
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashVersion(offerId, version, commitment, expiresAt, deadline);
        vm.prank(relayer);
        ledger.publishVersion(offerId, version, commitment, expiresAt, deadline, _sign(pk, digest));
    }

    function _setOfferState(uint256 pk, bytes32 offerId, uint8 state, uint32 seq) internal {
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashOfferState(offerId, state, seq, deadline);
        vm.prank(relayer);
        ledger.setOfferState(offerId, state, seq, deadline, _sign(pk, digest));
    }

    function _request(uint256 pk, bytes32 requestId, bytes32 offerId, uint32 version) internal {
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashRequest(requestId, offerId, version, deadline);
        vm.prank(relayer);
        ledger.recordRequest(requestId, offerId, version, deadline, _sign(pk, digest));
    }

    function _accept(bytes32 requestId, uint32 counter, bytes32 terms, bool sellerFirst) internal {
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashAcceptance(requestId, counter, terms, deadline);
        bytes memory sellerSig = _sign(SELLER_PK, digest);
        bytes memory buyerSig = _sign(BUYER_PK, digest);
        vm.prank(relayer);
        if (sellerFirst) {
            ledger.recordAcceptance(requestId, counter, terms, deadline, sellerSig, buyerSig);
        } else {
            ledger.recordAcceptance(requestId, counter, terms, deadline, buyerSig, sellerSig);
        }
    }

    function _status(uint256 pk, bytes32 requestId, uint8 status, uint32 seq) internal {
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashStatus(requestId, status, seq, deadline);
        vm.prank(relayer);
        ledger.recordStatus(requestId, status, seq, deadline, _sign(pk, digest));
    }

    function _cancel(bytes32 requestId, bool sellerFirst) internal {
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashCancellation(requestId, deadline);
        bytes memory sellerSig = _sign(SELLER_PK, digest);
        bytes memory buyerSig = _sign(BUYER_PK, digest);
        vm.prank(relayer);
        if (sellerFirst) {
            ledger.recordCancellation(requestId, deadline, sellerSig, buyerSig);
        } else {
            ledger.recordCancellation(requestId, deadline, buyerSig, sellerSig);
        }
    }

    function _openRequest() internal returns (bytes32 offerId, bytes32 requestId) {
        offerId = _id();
        requestId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        _request(BUYER_PK, requestId, offerId, 1);
    }

    /// @dev Independent copy of the D-20 table. The contract must match this, not the other way around.
    function _specStatus(uint8 from, uint8 to) internal pure returns (bool) {
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

    function _specOffer(uint8 from, uint8 to) internal pure returns (bool) {
        if (from == uint8(OfferState.Published) && to == uint8(OfferState.Paused)) return true;
        if (from == uint8(OfferState.Paused) && to == uint8(OfferState.Published)) return true;
        if (
            (from == uint8(OfferState.Published) || from == uint8(OfferState.Paused))
                && to == uint8(OfferState.Withdrawn)
        ) return true;
        return false;
    }

    function _reach(uint8 from) internal returns (bytes32 requestId) {
        bytes32 offerId;
        (offerId, requestId) = _openRequest();
        if (from == uint8(Fulfilment.Requested)) return requestId;
        _accept(requestId, 0, _id(), true);
        if (from == uint8(Fulfilment.Accepted)) return requestId;
        if (from == uint8(Fulfilment.CarrierPending)) {
            _status(SELLER_PK, requestId, uint8(Fulfilment.CarrierPending), 0);
            return requestId;
        }
        if (from == uint8(Fulfilment.CarrierConfirmed)) {
            _status(SELLER_PK, requestId, uint8(Fulfilment.CarrierConfirmed), 0);
            return requestId;
        }
        if (from == uint8(Fulfilment.Rejected)) {
            _status(SELLER_PK, requestId, uint8(Fulfilment.CarrierPending), 0);
            _status(SELLER_PK, requestId, uint8(Fulfilment.Rejected), 1);
            return requestId;
        }
        if (from == uint8(Fulfilment.Rolled)) {
            _status(SELLER_PK, requestId, uint8(Fulfilment.CarrierConfirmed), 0);
            _status(SELLER_PK, requestId, uint8(Fulfilment.Rolled), 1);
            return requestId;
        }
        if (from == uint8(Fulfilment.Completed)) {
            _status(SELLER_PK, requestId, uint8(Fulfilment.CarrierConfirmed), 0);
            _status(SELLER_PK, requestId, uint8(Fulfilment.Completed), 1);
            return requestId;
        }
        if (from == uint8(Fulfilment.Cancelled)) {
            _cancel(requestId, true);
            return requestId;
        }
        revert("state not reachable");
    }
}

abstract contract TradingFixture is LedgerFixture {
    function setUp() public virtual override {
        super.setUp();
        _bind(SELLER_PK, SELLER_CO);
        _bind(SELLER2_PK, SELLER_CO);
        _bind(BUYER_PK, BUYER_CO);
        _bind(BUYER2_PK, BUYER_CO);
        _bind(OTHER_PK, OTHER_CO);
        ledger.setOperator(operator, true);
    }
}
