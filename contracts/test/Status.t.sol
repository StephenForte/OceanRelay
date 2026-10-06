// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TradingFixture} from "./LedgerFixture.sol";
import {OceanRelayLedger, Fulfilment} from "../src/OceanRelayLedger.sol";

contract StatusTest is TradingFixture {
    function test_statusTableMatchesSpec() public view {
        for (uint16 from; from < 256; ++from) {
            for (uint16 to; to < 256; ++to) {
                assertEq(ledger.statusMoveAllowed(uint8(from), uint8(to)), _specStatus(uint8(from), uint8(to)));
            }
        }
    }

    function test_everyAllowedStatusMove() public {
        uint8[9] memory froms = [uint8(2), 2, 3, 3, 4, 4, 4, 6, 6];
        uint8[9] memory tos = [uint8(3), 4, 4, 5, 6, 7, 5, 3, 4];
        for (uint256 i; i < froms.length; ++i) {
            bytes32 requestId = _reach(froms[i]);
            (,,, uint32 seq,,) = ledger.getRequest(requestId);
            if (i == 0) {
                uint64 deadline = _deadline();
                bytes32 digest = ledger.hashStatus(requestId, tos[i], seq, deadline);
                vm.expectEmit(true, false, false, true);
                emit OceanRelayLedger.StatusRecorded(requestId, tos[i], seq, seller);
                vm.recordLogs();
                vm.prank(relayer);
                ledger.recordStatus(requestId, tos[i], seq, deadline, _sign(SELLER_PK, digest));
                assertEq(vm.getRecordedLogs().length, 1);
            } else if (i == 1) {
                _status(BUYER_PK, requestId, tos[i], seq);
            } else {
                _status(SELLER_PK, requestId, tos[i], seq);
            }
            (,,,, Fulfilment status,) = ledger.getRequest(requestId);
            assertEq(uint8(status), tos[i]);
            (,,, uint32 nextSeq,,) = ledger.getRequest(requestId);
            assertEq(nextSeq, seq + 1);
        }
    }

    function test_everyOtherStatusPairReverts() public {
        for (uint8 from = 1; from <= 8; ++from) {
            bytes32 requestId = _reach(from);
            (,,, uint32 seq,,) = ledger.getRequest(requestId);
            for (uint16 to; to < 256; ++to) {
                if (_specStatus(from, uint8(to))) continue;
                uint64 deadline = uint64(block.timestamp + 1 days + to);
                bytes32 digest = ledger.hashStatus(requestId, uint8(to), seq, deadline);
                vm.prank(relayer);
                (bool ok, bytes memory data) = address(ledger)
                    .call(
                        abi.encodeCall(
                            OceanRelayLedger.recordStatus,
                            (requestId, uint8(to), seq, deadline, _sign(SELLER_PK, digest))
                        )
                    );
                assertFalse(ok);
                assertEq(bytes4(data), OceanRelayLedger.BadFulfilment.selector);
            }
        }
    }

    function testFuzz_statusPairs(uint8 from, uint8 to) public {
        assertEq(ledger.statusMoveAllowed(from, to), _specStatus(from, to));
        if (from == 0 || from > 8) return;
        bytes32 requestId = _reach(from);
        (,,, uint32 seq,,) = ledger.getRequest(requestId);
        uint64 deadline = uint64(block.timestamp + 3 days);
        bytes32 digest = ledger.hashStatus(requestId, to, seq, deadline);
        bytes memory sig = _sign(SELLER_PK, digest);
        if (_specStatus(from, to)) {
            vm.prank(relayer);
            ledger.recordStatus(requestId, to, seq, deadline, sig);
            (,,,, Fulfilment status,) = ledger.getRequest(requestId);
            assertEq(uint8(status), to);
        } else {
            vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.BadFulfilment.selector, to));
            vm.prank(relayer);
            ledger.recordStatus(requestId, to, seq, deadline, sig);
        }
    }

    function test_operatorCanRecordStatus() public {
        (, bytes32 requestId) = _openRequest();
        _accept(requestId, 0, _id(), true);
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashStatus(requestId, uint8(Fulfilment.CarrierPending), 0, deadline);
        vm.prank(relayer);
        ledger.recordStatus(requestId, uint8(Fulfilment.CarrierPending), 0, deadline, _sign(OPERATOR_PK, digest));
        (,,,, Fulfilment status,) = ledger.getRequest(requestId);
        assertEq(uint8(status), uint8(Fulfilment.CarrierPending));
    }

    function test_unboundNonOperatorCannotRecordStatus() public {
        (, bytes32 requestId) = _openRequest();
        _accept(requestId, 0, _id(), true);
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashStatus(requestId, uint8(Fulfilment.CarrierPending), 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotParty.selector, stranger));
        vm.prank(relayer);
        ledger.recordStatus(requestId, uint8(Fulfilment.CarrierPending), 0, deadline, _sign(STRANGER_PK, digest));
    }

    function test_boundThirdCompanyCannotRecordStatus() public {
        (, bytes32 requestId) = _openRequest();
        _accept(requestId, 0, _id(), true);
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashStatus(requestId, uint8(Fulfilment.CarrierConfirmed), 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotParty.selector, other));
        vm.prank(relayer);
        ledger.recordStatus(requestId, uint8(Fulfilment.CarrierConfirmed), 0, deadline, _sign(OTHER_PK, digest));
    }

    function test_staleStatusSeqReverts() public {
        (, bytes32 requestId) = _openRequest();
        _accept(requestId, 0, _id(), true);
        _status(SELLER_PK, requestId, uint8(Fulfilment.CarrierPending), 0);
        uint64 deadline = uint64(block.timestamp + 2 days);
        bytes32 digest = ledger.hashStatus(requestId, uint8(Fulfilment.CarrierConfirmed), 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.BadSequence.selector, uint32(1), uint32(0)));
        vm.prank(relayer);
        ledger.recordStatus(requestId, uint8(Fulfilment.CarrierConfirmed), 0, deadline, _sign(SELLER_PK, digest));
    }

    function test_signedRolledCannotApplyOutOfOrder() public {
        (, bytes32 requestId) = _openRequest();
        _accept(requestId, 0, _id(), true);
        uint64 deadline = uint64(block.timestamp + 30 days);
        bytes32 digest = ledger.hashStatus(requestId, uint8(Fulfilment.Rolled), 0, deadline);
        bytes memory sig = _sign(SELLER_PK, digest);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.BadFulfilment.selector, uint8(Fulfilment.Rolled)));
        vm.prank(relayer);
        ledger.recordStatus(requestId, uint8(Fulfilment.Rolled), 0, deadline, sig);

        _status(SELLER_PK, requestId, uint8(Fulfilment.CarrierConfirmed), 0);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.BadSequence.selector, uint32(1), uint32(0)));
        vm.prank(relayer);
        ledger.recordStatus(requestId, uint8(Fulfilment.Rolled), 0, deadline, sig);
    }

    function test_cancellationBothOrdersAndEvent() public {
        (, bytes32 requestId) = _openRequest();
        _accept(requestId, 0, _id(), true);
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashCancellation(requestId, deadline);
        vm.expectEmit(true, false, false, true);
        emit OceanRelayLedger.CancellationRecorded(requestId, buyer, seller);
        vm.recordLogs();
        vm.prank(relayer);
        ledger.recordCancellation(requestId, deadline, _sign(BUYER_PK, digest), _sign(SELLER_PK, digest));
        assertEq(vm.getRecordedLogs().length, 1);
        (,,,, Fulfilment status,) = ledger.getRequest(requestId);
        assertEq(uint8(status), uint8(Fulfilment.Cancelled));

        (, bytes32 second) = _openRequest();
        _accept(second, 1, _id(), false);
        _cancel(second, true);
        (,,,, status,) = ledger.getRequest(second);
        assertEq(uint8(status), uint8(Fulfilment.Cancelled));
    }

    function test_cancellationFromEachAllowedState() public {
        uint8[5] memory froms = [uint8(2), 3, 4, 5, 6];
        for (uint256 i; i < froms.length; ++i) {
            bytes32 requestId = _reach(froms[i]);
            _cancel(requestId, i % 2 == 0);
            (,,,, Fulfilment status,) = ledger.getRequest(requestId);
            assertEq(uint8(status), uint8(Fulfilment.Cancelled));
        }
    }

    function test_cancellationSameCompanyReverts() public {
        (, bytes32 requestId) = _openRequest();
        _accept(requestId, 0, _id(), true);
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashCancellation(requestId, deadline);
        vm.expectRevert(OceanRelayLedger.SameCompanySignatures.selector);
        vm.prank(relayer);
        ledger.recordCancellation(requestId, deadline, _sign(SELLER_PK, digest), _sign(SELLER2_PK, digest));
    }

    function test_cancellationSameSignatureTwiceReverts() public {
        (, bytes32 requestId) = _openRequest();
        _accept(requestId, 0, _id(), true);
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashCancellation(requestId, deadline);
        bytes memory sig = _sign(BUYER_PK, digest);
        vm.expectRevert(OceanRelayLedger.DuplicateSigner.selector);
        vm.prank(relayer);
        ledger.recordCancellation(requestId, deadline, sig, sig);
    }

    function test_cancellationFromCompletedOrCancelledReverts() public {
        bytes32 completed = _reach(uint8(Fulfilment.Completed));
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashCancellation(completed, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotCancellable.selector, uint8(Fulfilment.Completed)));
        vm.prank(relayer);
        ledger.recordCancellation(completed, deadline, _sign(SELLER_PK, digest), _sign(BUYER_PK, digest));

        bytes32 cancelled = _reach(uint8(Fulfilment.Cancelled));
        deadline = uint64(block.timestamp + 2 days);
        digest = ledger.hashCancellation(cancelled, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotCancellable.selector, uint8(Fulfilment.Cancelled)));
        vm.prank(relayer);
        ledger.recordCancellation(cancelled, deadline, _sign(SELLER_PK, digest), _sign(BUYER_PK, digest));
    }

    function test_cancellationFromRequestedReverts() public {
        (, bytes32 requestId) = _openRequest();
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashCancellation(requestId, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotCancellable.selector, uint8(Fulfilment.Requested)));
        vm.prank(relayer);
        ledger.recordCancellation(requestId, deadline, _sign(SELLER_PK, digest), _sign(BUYER_PK, digest));
    }

    function test_statusAfterCancelledReverts() public {
        bytes32 requestId = _reach(uint8(Fulfilment.Cancelled));
        (,,, uint32 seq,,) = ledger.getRequest(requestId);
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashStatus(requestId, uint8(Fulfilment.CarrierPending), seq, deadline);
        vm.expectRevert(
            abi.encodeWithSelector(OceanRelayLedger.BadFulfilment.selector, uint8(Fulfilment.CarrierPending))
        );
        vm.prank(relayer);
        ledger.recordStatus(requestId, uint8(Fulfilment.CarrierPending), seq, deadline, _sign(SELLER_PK, digest));
    }
}
