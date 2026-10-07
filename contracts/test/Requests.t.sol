// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TradingFixture} from "./LedgerFixture.sol";
import {OceanRelayLedger, OfferState, Fulfilment} from "../src/OceanRelayLedger.sol";

contract RequestsTest is TradingFixture {
    function test_request_succeedsAndEmits() public {
        bytes32 offerId = _id();
        bytes32 requestId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashRequest(requestId, offerId, 1, deadline);
        vm.expectEmit(true, true, true, true);
        emit OceanRelayLedger.RequestRecorded(requestId, offerId, BUYER_CO, 1, buyer);
        vm.recordLogs();
        vm.prank(relayer);
        ledger.recordRequest(requestId, offerId, 1, deadline, _sign(BUYER_PK, digest));
        assertEq(vm.getRecordedLogs().length, 1);
        (bytes32 storedOffer, bytes32 buyerCompany, uint32 version, uint32 seq, Fulfilment status,) =
            ledger.getRequest(requestId);
        assertEq(storedOffer, offerId);
        assertEq(buyerCompany, BUYER_CO);
        assertEq(version, 1);
        assertEq(seq, 0);
        assertEq(uint8(status), uint8(Fulfilment.Requested));
    }

    function test_requestByOwnCompanyReverts() public {
        bytes32 offerId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        uint64 deadline = _deadline();
        bytes32 requestId = _id();
        bytes32 digest = ledger.hashRequest(requestId, offerId, 1, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.SameCompanyRequest.selector, SELLER_CO));
        ledger.recordRequest(requestId, offerId, 1, deadline, _sign(SELLER_PK, digest));
    }

    function test_requestOnPausedOfferReverts() public {
        bytes32 offerId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        _setOfferState(SELLER_PK, offerId, uint8(OfferState.Paused), 0);
        uint64 deadline = _deadline();
        bytes32 requestId = _id();
        bytes32 digest = ledger.hashRequest(requestId, offerId, 1, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.OfferNotPublished.selector, uint8(OfferState.Paused)));
        ledger.recordRequest(requestId, offerId, 1, deadline, _sign(BUYER_PK, digest));
    }

    function test_requestAtStaleVersionReverts() public {
        bytes32 offerId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        _publishVersion(SELLER_PK, offerId, 2, _id(), _expiry());
        uint64 deadline = _deadline();
        bytes32 requestId = _id();
        bytes32 digest = ledger.hashRequest(requestId, offerId, 1, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.StaleVersion.selector, uint32(2), uint32(1)));
        ledger.recordRequest(requestId, offerId, 1, deadline, _sign(BUYER_PK, digest));
    }

    function test_duplicateRequestIdReverts() public {
        bytes32 offerId = _id();
        bytes32 requestId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        _request(BUYER_PK, requestId, offerId, 1);
        bytes32 otherOffer = _id();
        _publish(SELLER_PK, otherOffer, _id(), _expiry());
        uint64 deadline = uint64(block.timestamp + 2 days);
        bytes32 digest = ledger.hashRequest(requestId, otherOffer, 1, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.DuplicateRequest.selector, requestId));
        ledger.recordRequest(requestId, otherOffer, 1, deadline, _sign(BUYER_PK, digest));
    }

    function test_zeroRequestIdReverts() public {
        bytes32 offerId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        vm.prank(relayer);
        vm.expectRevert(OceanRelayLedger.ZeroRequestId.selector);
        ledger.recordRequest(bytes32(0), offerId, 1, _deadline(), hex"11");
    }

    function test_acceptanceBothOrders() public {
        (bytes32 offerId, bytes32 requestId) = _openRequest();
        bytes32 terms = _id();
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashAcceptance(requestId, 0, terms, deadline);
        vm.expectEmit(true, false, false, true);
        emit OceanRelayLedger.AcceptanceRecorded(requestId, 0, terms, seller, buyer);
        vm.recordLogs();
        vm.prank(relayer);
        ledger.recordAcceptance(requestId, 0, terms, deadline, _sign(SELLER_PK, digest), _sign(BUYER_PK, digest));
        assertEq(vm.getRecordedLogs().length, 1);
        (,,,, Fulfilment status, bytes32 storedTerms) = ledger.getRequest(requestId);
        assertEq(uint8(status), uint8(Fulfilment.Accepted));
        assertEq(storedTerms, terms);
        offerId;

        (, bytes32 second) = _openRequest();
        bytes32 terms2 = _id();
        deadline = uint64(block.timestamp + 2 days);
        digest = ledger.hashAcceptance(second, 4, terms2, deadline);
        vm.expectEmit(true, false, false, true);
        emit OceanRelayLedger.AcceptanceRecorded(second, 4, terms2, buyer, seller);
        vm.prank(relayer);
        ledger.recordAcceptance(second, 4, terms2, deadline, _sign(BUYER_PK, digest), _sign(SELLER_PK, digest));
        (,,,, status,) = ledger.getRequest(second);
        assertEq(uint8(status), uint8(Fulfilment.Accepted));
    }

    function test_acceptanceSameCompanyReverts() public {
        (, bytes32 requestId) = _openRequest();
        uint64 deadline = _deadline();
        bytes32 terms = _id();
        bytes32 digest = ledger.hashAcceptance(requestId, 0, terms, deadline);
        vm.prank(relayer);
        vm.expectRevert(OceanRelayLedger.SameCompanySignatures.selector);
        ledger.recordAcceptance(requestId, 0, terms, deadline, _sign(SELLER_PK, digest), _sign(SELLER2_PK, digest));
    }

    function test_acceptanceSameSignatureTwiceReverts() public {
        (, bytes32 requestId) = _openRequest();
        uint64 deadline = _deadline();
        bytes32 terms = _id();
        bytes32 digest = ledger.hashAcceptance(requestId, 0, terms, deadline);
        bytes memory sig = _sign(SELLER_PK, digest);
        vm.prank(relayer);
        vm.expectRevert(OceanRelayLedger.DuplicateSigner.selector);
        ledger.recordAcceptance(requestId, 0, terms, deadline, sig, sig);
    }

    function test_acceptanceThirdCompanyReverts() public {
        (, bytes32 requestId) = _openRequest();
        uint64 deadline = _deadline();
        bytes32 terms = _id();
        bytes32 digest = ledger.hashAcceptance(requestId, 0, terms, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotParty.selector, seller));
        ledger.recordAcceptance(requestId, 0, terms, deadline, _sign(SELLER_PK, digest), _sign(OTHER_PK, digest));
    }

    function test_acceptanceAfterNewVersionReverts() public {
        (bytes32 offerId, bytes32 requestId) = _openRequest();
        _publishVersion(SELLER_PK, offerId, 2, _id(), _expiry());
        uint64 deadline = _deadline();
        bytes32 terms = _id();
        bytes32 digest = ledger.hashAcceptance(requestId, 0, terms, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.StaleVersion.selector, uint32(2), uint32(1)));
        ledger.recordAcceptance(requestId, 0, terms, deadline, _sign(SELLER_PK, digest), _sign(BUYER_PK, digest));
    }

    function test_secondAcceptanceReverts() public {
        (, bytes32 requestId) = _openRequest();
        bytes32 terms = _id();
        _accept(requestId, 0, terms, true);
        uint64 deadline = uint64(block.timestamp + 2 days);
        bytes32 digest = ledger.hashAcceptance(requestId, 1, _id(), deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.BadFulfilment.selector, uint8(Fulfilment.Accepted)));
        ledger.recordAcceptance(requestId, 1, _id(), deadline, _sign(SELLER_PK, digest), _sign(BUYER_PK, digest));
    }

    function test_acceptanceZeroCommitmentReverts() public {
        (, bytes32 requestId) = _openRequest();
        vm.prank(relayer);
        vm.expectRevert(OceanRelayLedger.ZeroCommitment.selector);
        ledger.recordAcceptance(requestId, 0, bytes32(0), _deadline(), hex"11", hex"22");
    }

    function test_acceptanceOnPausedOfferReverts() public {
        (bytes32 offerId, bytes32 requestId) = _openRequest();
        _setOfferState(SELLER_PK, offerId, uint8(OfferState.Paused), 0);
        uint64 deadline = _deadline();
        bytes32 terms = _id();
        bytes32 digest = ledger.hashAcceptance(requestId, 0, terms, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.OfferNotPublished.selector, uint8(OfferState.Paused)));
        ledger.recordAcceptance(requestId, 0, terms, deadline, _sign(SELLER_PK, digest), _sign(BUYER_PK, digest));
    }
}
