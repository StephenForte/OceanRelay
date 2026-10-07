// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {TradingFixture} from "./LedgerFixture.sol";
import {OceanRelayLedger, OfferState} from "../src/OceanRelayLedger.sol";

contract RolesTest is TradingFixture {
    function test_constructorRejectsZeroAndSameKeys() public {
        vm.expectRevert(OceanRelayLedger.ZeroAddress.selector);
        new OceanRelayLedger(address(0), registrar);
        vm.expectRevert(OceanRelayLedger.ZeroAddress.selector);
        new OceanRelayLedger(relayer, address(0));
        vm.expectRevert(OceanRelayLedger.RelayerRegistrarConflict.selector);
        new OceanRelayLedger(relayer, relayer);
    }

    function test_nonRelayerRevertsOnEveryRecordFunction() public {
        bytes32 offerId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        (, bytes32 requestId) = _openRequest();
        uint64 deadline = _deadline();
        bytes memory sig = hex"11";

        _asStranger(abi.encodeCall(OceanRelayLedger.bindWallet, (SELLER_CO, stranger, deadline, sig, sig)));
        _asStranger(abi.encodeCall(OceanRelayLedger.publishOffer, (_id(), _id(), _expiry(), deadline, sig)));
        _asStranger(abi.encodeCall(OceanRelayLedger.publishVersion, (offerId, 2, _id(), _expiry(), deadline, sig)));
        _asStranger(
            abi.encodeCall(OceanRelayLedger.setOfferState, (offerId, uint8(OfferState.Paused), 0, deadline, sig))
        );
        _asStranger(abi.encodeCall(OceanRelayLedger.markExpired, (offerId)));
        _asStranger(abi.encodeCall(OceanRelayLedger.recordRequest, (_id(), offerId, 1, deadline, sig)));
        _asStranger(abi.encodeCall(OceanRelayLedger.recordAcceptance, (requestId, 0, _id(), deadline, sig, sig)));
        _asStranger(abi.encodeCall(OceanRelayLedger.recordStatus, (requestId, 3, 0, deadline, sig)));
        _asStranger(abi.encodeCall(OceanRelayLedger.recordCancellation, (requestId, deadline, sig, sig)));
    }

    function test_pauseBlocksEveryRecordFunction() public {
        bytes32 offerId = _id();
        uint64 expiresAt = _expiry();
        _publish(SELLER_PK, offerId, _id(), expiresAt);
        (, bytes32 requestId) = _openRequest();
        ledger.pause();
        assertTrue(ledger.paused());

        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashPublish(_id(), _id(), _expiry(), deadline);
        bytes memory sig = _sign(SELLER_PK, digest);
        _paused(abi.encodeCall(OceanRelayLedger.bindWallet, (OTHER_CO, stranger, deadline, sig, sig)));
        _paused(abi.encodeCall(OceanRelayLedger.publishOffer, (_id(), _id(), _expiry(), deadline, sig)));
        _paused(abi.encodeCall(OceanRelayLedger.publishVersion, (offerId, 2, _id(), _expiry(), deadline, sig)));
        _paused(abi.encodeCall(OceanRelayLedger.setOfferState, (offerId, uint8(OfferState.Paused), 0, deadline, sig)));
        _paused(abi.encodeCall(OceanRelayLedger.markExpired, (offerId)));
        _paused(abi.encodeCall(OceanRelayLedger.recordRequest, (_id(), offerId, 1, deadline, sig)));
        _paused(abi.encodeCall(OceanRelayLedger.recordAcceptance, (requestId, 0, _id(), deadline, sig, sig)));
        _paused(abi.encodeCall(OceanRelayLedger.recordStatus, (requestId, 3, 0, deadline, sig)));
        _paused(abi.encodeCall(OceanRelayLedger.recordCancellation, (requestId, deadline, sig, sig)));

        ledger.unpause();
        vm.warp(uint256(expiresAt) + 1);
        vm.prank(relayer);
        ledger.markExpired(offerId);
        (,,, OfferState state,,) = ledger.getOffer(offerId);
        assertEq(uint8(state), uint8(OfferState.Expired));
    }

    function test_ownershipTransferIsTwoStep() public {
        address next = vm.addr(0xA11CE);
        ledger.transferOwnership(next);
        assertEq(ledger.owner(), address(this));
        assertEq(ledger.pendingOwner(), next);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        ledger.acceptOwnership();
        vm.prank(next);
        ledger.acceptOwnership();
        assertEq(ledger.owner(), next);
        assertEq(ledger.pendingOwner(), address(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        ledger.setRelayer(vm.addr(0x999));
    }

    function test_setRelayerTakesEffectForOldAndNew() public {
        bytes32 offerId = _id();
        uint64 expiresAt = _expiry();
        _publish(SELLER_PK, offerId, _id(), expiresAt);
        address next = vm.addr(0x999);
        vm.expectEmit(true, false, false, true);
        emit OceanRelayLedger.RelayerUpdated(next);
        ledger.setRelayer(next);
        assertEq(ledger.relayer(), next);

        vm.warp(uint256(expiresAt) + 1);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotRelayer.selector, relayer));
        vm.prank(relayer);
        ledger.markExpired(offerId);
        vm.prank(next);
        ledger.markExpired(offerId);
        (,,, OfferState state,,) = ledger.getOffer(offerId);
        assertEq(uint8(state), uint8(OfferState.Expired));
    }

    function test_relayerOwnSignatureRevertsOnOfferFunctions() public {
        bytes32 offerId = _id();
        uint64 expiresAt = _expiry();
        _publish(SELLER_PK, offerId, _id(), expiresAt);
        uint64 deadline = _deadline();

        bytes32 bindDigest = ledger.hashBinding(OTHER_CO, relayer, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotRegistrar.selector, relayer));
        vm.prank(relayer);
        ledger.bindWallet(OTHER_CO, relayer, deadline, _sign(RELAYER_PK, bindDigest), _sign(RELAYER_PK, bindDigest));

        bytes32 freshOffer = _id();
        bytes32 freshCommitment = _id();
        bytes32 publishDigest = ledger.hashPublish(freshOffer, freshCommitment, expiresAt, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.WalletNotBound.selector, relayer));
        vm.prank(relayer);
        ledger.publishOffer(freshOffer, freshCommitment, expiresAt, deadline, _sign(RELAYER_PK, publishDigest));

        bytes32 versionDigest = ledger.hashVersion(offerId, 2, freshCommitment, expiresAt, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.WalletNotBound.selector, relayer));
        vm.prank(relayer);
        ledger.publishVersion(offerId, 2, freshCommitment, expiresAt, deadline, _sign(RELAYER_PK, versionDigest));

        bytes32 stateDigest = ledger.hashOfferState(offerId, uint8(OfferState.Paused), 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.WalletNotBound.selector, relayer));
        vm.prank(relayer);
        ledger.setOfferState(offerId, uint8(OfferState.Paused), 0, deadline, _sign(RELAYER_PK, stateDigest));
    }

    function test_relayerOwnSignatureRevertsOnRequestFunctions() public {
        bytes32 offerId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        (, bytes32 requestId) = _openRequest();
        _accept(requestId, 0, _id(), true);
        uint64 deadline = _deadline();

        bytes32 freshRequest = _id();
        bytes32 requestDigest = ledger.hashRequest(freshRequest, offerId, 1, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.WalletNotBound.selector, relayer));
        vm.prank(relayer);
        ledger.recordRequest(freshRequest, offerId, 1, deadline, _sign(RELAYER_PK, requestDigest));

        (, bytes32 pending) = _openRequest();
        bytes32 terms = _id();
        bytes32 acceptDigest = ledger.hashAcceptance(pending, 0, terms, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.WalletNotBound.selector, relayer));
        vm.prank(relayer);
        ledger.recordAcceptance(
            pending, 0, terms, deadline, _sign(RELAYER_PK, acceptDigest), _sign(BUYER_PK, acceptDigest)
        );

        bytes32 statusDigest = ledger.hashStatus(requestId, 3, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotParty.selector, relayer));
        vm.prank(relayer);
        ledger.recordStatus(requestId, 3, 0, deadline, _sign(RELAYER_PK, statusDigest));

        bytes32 cancelDigest = ledger.hashCancellation(requestId, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.WalletNotBound.selector, relayer));
        vm.prank(relayer);
        ledger.recordCancellation(requestId, deadline, _sign(RELAYER_PK, cancelDigest), _sign(BUYER_PK, cancelDigest));
    }

    function _asStranger(bytes memory data) internal {
        vm.prank(stranger);
        (bool ok, bytes memory ret) = address(ledger).call(data);
        assertFalse(ok);
        assertEq(bytes4(ret), OceanRelayLedger.NotRelayer.selector);
    }

    function _paused(bytes memory data) internal {
        vm.prank(relayer);
        (bool ok, bytes memory ret) = address(ledger).call(data);
        assertFalse(ok);
        assertEq(bytes4(ret), Pausable.EnforcedPause.selector);
    }
}
