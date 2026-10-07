// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TradingFixture} from "./LedgerFixture.sol";
import {OceanRelayLedger, OfferState} from "../src/OceanRelayLedger.sol";

contract OffersTest is TradingFixture {
    function test_publish_succeedsAndEmits() public {
        bytes32 offerId = _id();
        bytes32 commitment = _id();
        uint64 expiresAt = _expiry();
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashPublish(offerId, commitment, expiresAt, deadline);
        vm.expectEmit(true, true, true, true);
        emit OceanRelayLedger.OfferPublished(offerId, SELLER_CO, seller, 1, commitment, expiresAt);
        vm.recordLogs();
        vm.prank(relayer);
        ledger.publishOffer(offerId, commitment, expiresAt, deadline, _sign(SELLER_PK, digest));
        assertEq(vm.getRecordedLogs().length, 1);

        (bytes32 companyKey, uint32 version, uint32 stateSeq, OfferState state, uint64 storedExpiry, bytes32 stored) =
            ledger.getOffer(offerId);
        assertEq(companyKey, SELLER_CO);
        assertEq(version, 1);
        assertEq(stateSeq, 0);
        assertEq(uint8(state), uint8(OfferState.Published));
        assertEq(storedExpiry, expiresAt);
        assertEq(stored, commitment);
    }

    function test_duplicateOfferIdReverts() public {
        bytes32 offerId = _id();
        bytes32 commitment = _id();
        uint64 expiresAt = _expiry();
        _publish(SELLER_PK, offerId, commitment, expiresAt);
        uint64 deadline = uint64(block.timestamp + 2 days);
        bytes32 digest = ledger.hashPublish(offerId, commitment, expiresAt, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.DuplicateOffer.selector, offerId));
        ledger.publishOffer(offerId, commitment, expiresAt, deadline, _sign(SELLER_PK, digest));
    }

    function test_zeroOfferIdReverts() public {
        uint64 deadline = _deadline();
        uint64 expiresAt = _expiry();
        bytes32 commitment = _id();
        vm.prank(relayer);
        vm.expectRevert(OceanRelayLedger.ZeroOfferId.selector);
        ledger.publishOffer(bytes32(0), commitment, expiresAt, deadline, _sign(SELLER_PK, bytes32(uint256(1))));
    }

    function test_zeroCommitmentReverts() public {
        uint64 deadline = _deadline();
        vm.prank(relayer);
        vm.expectRevert(OceanRelayLedger.ZeroCommitment.selector);
        ledger.publishOffer(_id(), bytes32(0), _expiry(), deadline, hex"11");
    }

    function test_pastExpiresAtReverts() public {
        vm.warp(1_000_000);
        uint64 deadline = uint64(block.timestamp + 1 days);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.ExpiryNotFuture.selector, uint64(block.timestamp)));
        ledger.publishOffer(_id(), _id(), uint64(block.timestamp), deadline, hex"11");
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.ExpiryNotFuture.selector, uint64(block.timestamp - 1)));
        ledger.publishOffer(_id(), _id(), uint64(block.timestamp - 1), deadline, hex"11");
    }

    function test_samePublishSignatureTwiceReverts() public {
        bytes32 offerId = _id();
        bytes32 commitment = _id();
        uint64 expiresAt = _expiry();
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashPublish(offerId, commitment, expiresAt, deadline);
        bytes memory sig = _sign(SELLER_PK, digest);
        vm.prank(relayer);
        ledger.publishOffer(offerId, commitment, expiresAt, deadline, sig);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.DigestUsed.selector, digest));
        ledger.publishOffer(offerId, commitment, expiresAt, deadline, sig);
    }

    function test_pastDeadlineReverts() public {
        vm.warp(1_000_000);
        uint64 deadline = uint64(block.timestamp - 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.DeadlineExpired.selector, deadline, block.timestamp));
        ledger.publishOffer(_id(), _id(), _expiry(), deadline, hex"11");
    }

    function test_deadlineEqualToNowSucceeds() public {
        vm.warp(1_000_000);
        bytes32 offerId = _id();
        bytes32 commitment = _id();
        uint64 expiresAt = uint64(block.timestamp + 10);
        uint64 deadline = uint64(block.timestamp);
        bytes32 digest = ledger.hashPublish(offerId, commitment, expiresAt, deadline);
        vm.prank(relayer);
        ledger.publishOffer(offerId, commitment, expiresAt, deadline, _sign(SELLER_PK, digest));
        (, uint32 version,,,,) = ledger.getOffer(offerId);
        assertEq(version, 1);
    }

    function test_versionFromAnotherCompanyReverts() public {
        bytes32 offerId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        uint64 deadline = _deadline();
        uint64 expiresAt = _expiry();
        bytes32 commitment = _id();
        bytes32 digest = ledger.hashVersion(offerId, 2, commitment, expiresAt, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotOfferOwner.selector, offerId, OTHER_CO));
        ledger.publishVersion(offerId, 2, commitment, expiresAt, deadline, _sign(OTHER_PK, digest));
    }

    function test_versionSkipRevertsAndNextSucceeds() public {
        bytes32 offerId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        uint64 expiresAt = _expiry();
        bytes32 commitment = _id();
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashVersion(offerId, 3, commitment, expiresAt, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.BadVersion.selector, uint32(2), uint32(3)));
        ledger.publishVersion(offerId, 3, commitment, expiresAt, deadline, _sign(SELLER_PK, digest));

        deadline = uint64(block.timestamp + 2 days);
        digest = ledger.hashVersion(offerId, 1, commitment, expiresAt, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.BadVersion.selector, uint32(2), uint32(1)));
        ledger.publishVersion(offerId, 1, commitment, expiresAt, deadline, _sign(SELLER_PK, digest));

        bytes32 nextCommitment = _id();
        vm.expectEmit(true, false, false, true);
        emit OceanRelayLedger.VersionPublished(offerId, 2, nextCommitment, expiresAt, seller);
        vm.recordLogs();
        _publishVersion(SELLER_PK, offerId, 2, nextCommitment, expiresAt);
        assertEq(vm.getRecordedLogs().length, 1);
        (, uint32 version,,, uint64 storedExpiry, bytes32 stored) = ledger.getOffer(offerId);
        assertEq(version, 2);
        assertEq(stored, nextCommitment);
        assertEq(storedExpiry, expiresAt);

        deadline = uint64(block.timestamp + 3 days);
        bytes32 skipped = _id();
        digest = ledger.hashVersion(offerId, 4, skipped, expiresAt, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.BadVersion.selector, uint32(3), uint32(4)));
        ledger.publishVersion(offerId, 4, skipped, expiresAt, deadline, _sign(SELLER_PK, digest));
    }

    function test_versionWhilePausedSucceedsAndWhileFinalReverts() public {
        bytes32 offerId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        _setOfferState(SELLER_PK, offerId, uint8(OfferState.Paused), 0);
        _publishVersion(SELLER_PK, offerId, 2, _id(), _expiry());
        (, uint32 version,, OfferState state,,) = ledger.getOffer(offerId);
        assertEq(version, 2);
        assertEq(uint8(state), uint8(OfferState.Paused));

        bytes32 withdrawn = _id();
        _publish(SELLER_PK, withdrawn, _id(), _expiry());
        _setOfferState(SELLER_PK, withdrawn, uint8(OfferState.Withdrawn), 0);
        uint64 deadline = _deadline();
        uint64 nextExpiry = _expiry();
        bytes32 nextCommitment = _id();
        bytes32 digest = ledger.hashVersion(withdrawn, 2, nextCommitment, nextExpiry, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.BadOfferState.selector, uint8(OfferState.Withdrawn)));
        ledger.publishVersion(withdrawn, 2, nextCommitment, nextExpiry, deadline, _sign(SELLER_PK, digest));

        bytes32 expired = _id();
        uint64 expiresAt = _expiry();
        _publish(SELLER_PK, expired, _id(), expiresAt);
        vm.warp(uint256(expiresAt) + 1);
        vm.prank(relayer);
        ledger.markExpired(expired);
        deadline = _deadline();
        nextExpiry = uint64(block.timestamp + 10 days);
        nextCommitment = _id();
        digest = ledger.hashVersion(expired, 2, nextCommitment, nextExpiry, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.BadOfferState.selector, uint8(OfferState.Expired)));
        ledger.publishVersion(expired, 2, nextCommitment, nextExpiry, deadline, _sign(SELLER_PK, digest));
    }

    function test_zeroVersionCommitmentReverts() public {
        bytes32 offerId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        vm.prank(relayer);
        vm.expectRevert(OceanRelayLedger.ZeroCommitment.selector);
        ledger.publishVersion(offerId, 2, bytes32(0), _expiry(), _deadline(), hex"11");
    }

    function test_offerStateMovesAndEvent() public {
        bytes32 offerId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashOfferState(offerId, uint8(OfferState.Paused), 0, deadline);
        vm.expectEmit(true, false, false, true);
        emit OceanRelayLedger.OfferStateSet(offerId, uint8(OfferState.Paused), 0, seller);
        vm.recordLogs();
        vm.prank(relayer);
        ledger.setOfferState(offerId, uint8(OfferState.Paused), 0, deadline, _sign(SELLER_PK, digest));
        assertEq(vm.getRecordedLogs().length, 1);
        (,, uint32 seq, OfferState state,,) = ledger.getOffer(offerId);
        assertEq(uint8(state), uint8(OfferState.Paused));
        assertEq(seq, 1);

        _setOfferState(SELLER_PK, offerId, uint8(OfferState.Published), 1);
        (,, seq, state,,) = ledger.getOffer(offerId);
        assertEq(uint8(state), uint8(OfferState.Published));
        assertEq(seq, 2);

        _setOfferState(SELLER_PK, offerId, uint8(OfferState.Withdrawn), 2);
        (,,, state,,) = ledger.getOffer(offerId);
        assertEq(uint8(state), uint8(OfferState.Withdrawn));
    }

    function test_staleOfferSeqReverts() public {
        bytes32 offerId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        _setOfferState(SELLER_PK, offerId, uint8(OfferState.Paused), 0);
        uint64 deadline = uint64(block.timestamp + 2 days);
        bytes32 digest = ledger.hashOfferState(offerId, uint8(OfferState.Published), 0, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.BadSequence.selector, uint32(1), uint32(0)));
        ledger.setOfferState(offerId, uint8(OfferState.Published), 0, deadline, _sign(SELLER_PK, digest));
    }

    function test_offerStateIllegalMovesRevert() public {
        bytes32 publishedId = _id();
        _publish(SELLER_PK, publishedId, _id(), _expiry());
        _assertOfferMoves(publishedId, uint8(OfferState.Published), 0);

        bytes32 pausedId = _id();
        _publish(SELLER_PK, pausedId, _id(), _expiry());
        _setOfferState(SELLER_PK, pausedId, uint8(OfferState.Paused), 0);
        _assertOfferMoves(pausedId, uint8(OfferState.Paused), 1);

        bytes32 withdrawnId = _id();
        _publish(SELLER_PK, withdrawnId, _id(), _expiry());
        _setOfferState(SELLER_PK, withdrawnId, uint8(OfferState.Withdrawn), 0);
        _assertOfferMoves(withdrawnId, uint8(OfferState.Withdrawn), 1);

        bytes32 expiredId = _id();
        uint64 expiresAt = _expiry();
        _publish(SELLER_PK, expiredId, _id(), expiresAt);
        vm.warp(uint256(expiresAt) + 1);
        vm.prank(relayer);
        ledger.markExpired(expiredId);
        _assertOfferMoves(expiredId, uint8(OfferState.Expired), 0);
    }

    function test_markExpiredBeforeAtAndAfterAndFromEachState() public {
        vm.warp(1_000_000);
        uint64 expiresAt = uint64(block.timestamp + 100);

        bytes32 missing = _id();
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.OfferMissing.selector, missing));
        ledger.markExpired(missing);

        bytes32 live = _id();
        _publish(SELLER_PK, live, _id(), expiresAt);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotYetExpired.selector, live, expiresAt));
        ledger.markExpired(live);
        vm.warp(expiresAt);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotYetExpired.selector, live, expiresAt));
        ledger.markExpired(live);
        vm.warp(uint256(expiresAt) + 1);
        vm.expectEmit(true, false, false, true);
        emit OceanRelayLedger.OfferExpired(live);
        vm.recordLogs();
        vm.prank(relayer);
        ledger.markExpired(live);
        assertEq(vm.getRecordedLogs().length, 1);
        (,,, OfferState state,,) = ledger.getOffer(live);
        assertEq(uint8(state), uint8(OfferState.Expired));

        bytes32 paused = _id();
        _publish(SELLER_PK, paused, _id(), uint64(block.timestamp + 50));
        _setOfferState(SELLER_PK, paused, uint8(OfferState.Paused), 0);
        vm.warp(block.timestamp + 51);
        vm.prank(relayer);
        ledger.markExpired(paused);
        (,,, state,,) = ledger.getOffer(paused);
        assertEq(uint8(state), uint8(OfferState.Expired));

        bytes32 withdrawn = _id();
        uint64 withdrawnExpiry = uint64(block.timestamp + 80);
        _publish(SELLER_PK, withdrawn, _id(), withdrawnExpiry);
        _setOfferState(SELLER_PK, withdrawn, uint8(OfferState.Withdrawn), 0);
        vm.warp(uint256(withdrawnExpiry) + 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.BadOfferState.selector, uint8(OfferState.Withdrawn)));
        ledger.markExpired(withdrawn);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.BadOfferState.selector, uint8(OfferState.Expired)));
        ledger.markExpired(live);
    }

    function _assertOfferMoves(bytes32 offerId, uint8 from, uint32 seq) internal {
        for (uint16 to = 0; to < 256; ++to) {
            if (_specOffer(from, uint8(to))) continue;
            uint64 deadline = uint64(block.timestamp + 1 days + to);
            bytes32 digest = ledger.hashOfferState(offerId, uint8(to), seq, deadline);
            vm.prank(relayer);
            (bool ok, bytes memory data) = address(ledger)
                .call(
                    abi.encodeCall(
                        OceanRelayLedger.setOfferState, (offerId, uint8(to), seq, deadline, _sign(SELLER_PK, digest))
                    )
                );
            assertFalse(ok);
            assertEq(bytes4(data), OceanRelayLedger.BadOfferState.selector);
        }
        (,,, OfferState state,,) = ledger.getOffer(offerId);
        assertEq(uint8(state), from);
    }
}
