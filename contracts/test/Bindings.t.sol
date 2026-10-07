// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {LedgerFixture} from "./LedgerFixture.sol";
import {OceanRelayLedger} from "../src/OceanRelayLedger.sol";

contract BindingsTest is LedgerFixture {
    function test_bind_succeedsAndEmits() public {
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashBinding(SELLER_CO, seller, deadline);
        vm.expectEmit(true, true, false, true);
        emit OceanRelayLedger.WalletBound(SELLER_CO, seller);
        vm.recordLogs();
        vm.prank(relayer);
        ledger.bindWallet(SELLER_CO, seller, deadline, _sign(SELLER_PK, digest), _sign(REGISTRAR_PK, digest));
        assertEq(vm.getRecordedLogs().length, 1);
        assertEq(ledger.walletCompany(seller), SELLER_CO);
        assertTrue(ledger.usedDigests(digest));
    }

    function test_rebindSameCompanyReverts() public {
        _bind(SELLER_PK, SELLER_CO);
        uint64 deadline = uint64(block.timestamp + 2 days);
        bytes32 digest = ledger.hashBinding(SELLER_CO, seller, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.WalletAlreadyBound.selector, seller, SELLER_CO));
        ledger.bindWallet(SELLER_CO, seller, deadline, _sign(SELLER_PK, digest), _sign(REGISTRAR_PK, digest));
    }

    function test_rebindDifferentCompanyReverts() public {
        _bind(SELLER_PK, SELLER_CO);
        uint64 deadline = uint64(block.timestamp + 2 days);
        bytes32 digest = ledger.hashBinding(BUYER_CO, seller, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.WalletAlreadyBound.selector, seller, SELLER_CO));
        ledger.bindWallet(BUYER_CO, seller, deadline, _sign(SELLER_PK, digest), _sign(REGISTRAR_PK, digest));
    }

    function test_zeroCompanyKeyReverts() public {
        uint64 deadline = _deadline();
        vm.prank(relayer);
        vm.expectRevert(OceanRelayLedger.ZeroCompanyKey.selector);
        ledger.bindWallet(bytes32(0), seller, deadline, hex"11", hex"11");
    }

    function test_zeroWalletReverts() public {
        uint64 deadline = _deadline();
        vm.prank(relayer);
        vm.expectRevert(OceanRelayLedger.ZeroAddress.selector);
        ledger.bindWallet(SELLER_CO, address(0), deadline, hex"11", hex"11");
    }

    function test_signatureFromAnotherWalletReverts() public {
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashBinding(SELLER_CO, seller, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.SignerMismatch.selector, seller, seller2));
        ledger.bindWallet(SELLER_CO, seller, deadline, _sign(SELLER2_PK, digest), _sign(REGISTRAR_PK, digest));
    }

    function test_bindingSignedForADifferentCompanyKeyReverts() public {
        uint64 deadline = _deadline();
        bytes32 signedDigest = ledger.hashBinding(SELLER_CO, seller, deadline);
        bytes32 submitted = ledger.hashBinding(BUYER_CO, seller, deadline);
        vm.prank(relayer);
        (bool ok,) = address(ledger)
            .call(
                abi.encodeCall(
                    OceanRelayLedger.bindWallet,
                    (BUYER_CO, seller, deadline, _sign(SELLER_PK, signedDigest), _sign(REGISTRAR_PK, submitted))
                )
            );
        assertFalse(ok);
        assertEq(ledger.walletCompany(seller), bytes32(0));
    }

    function test_missingRegistrarSignatureReverts() public {
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashBinding(SELLER_CO, seller, deadline);
        vm.prank(relayer);
        vm.expectRevert(OceanRelayLedger.InvalidSignature.selector);
        ledger.bindWallet(SELLER_CO, seller, deadline, _sign(SELLER_PK, digest), bytes(""));
    }

    function test_registrarSignatureFromRelayerReverts() public {
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashBinding(SELLER_CO, seller, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotRegistrar.selector, relayer));
        ledger.bindWallet(SELLER_CO, seller, deadline, _sign(SELLER_PK, digest), _sign(RELAYER_PK, digest));
    }

    function test_sameSignatureTwiceReverts() public {
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashBinding(SELLER_CO, seller, deadline);
        bytes memory sig = _sign(SELLER_PK, digest);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotRegistrar.selector, seller));
        ledger.bindWallet(SELLER_CO, seller, deadline, sig, sig);
    }

    function test_setRegistrarRejectsRelayer() public {
        vm.expectRevert(OceanRelayLedger.RelayerRegistrarConflict.selector);
        ledger.setRegistrar(relayer);
        vm.expectRevert(OceanRelayLedger.RelayerRegistrarConflict.selector);
        ledger.setRelayer(registrar);
    }

    function test_oldRegistrarFailsAfterRotation() public {
        uint256 nextPk = 0xC34;
        address next = vm.addr(nextPk);
        ledger.setRegistrar(next);

        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashBinding(OTHER_CO, other, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotRegistrar.selector, registrar));
        ledger.bindWallet(OTHER_CO, other, deadline, _sign(OTHER_PK, digest), _sign(REGISTRAR_PK, digest));

        vm.prank(relayer);
        ledger.bindWallet(OTHER_CO, other, deadline, _sign(OTHER_PK, digest), _sign(nextPk, digest));
        assertEq(ledger.walletCompany(other), OTHER_CO);
    }

    function test_revokeByOwnerThenSignaturesFail() public {
        _bind(SELLER_PK, SELLER_CO);
        vm.expectEmit(true, false, false, true);
        emit OceanRelayLedger.WalletRevoked(seller, SELLER_CO);
        ledger.revokeWallet(seller);
        assertEq(ledger.walletCompany(seller), bytes32(0));

        bytes32 offerId = _id();
        uint64 deadline = _deadline();
        uint64 expiresAt = _expiry();
        bytes32 commitment = _id();
        bytes32 digest = ledger.hashPublish(offerId, commitment, expiresAt, deadline);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.WalletNotBound.selector, seller));
        ledger.publishOffer(offerId, commitment, expiresAt, deadline, _sign(SELLER_PK, digest));
    }

    function test_rebindAfterRevokeSucceeds() public {
        _bind(SELLER_PK, SELLER_CO);
        ledger.revokeWallet(seller);
        _bindAt(SELLER_PK, BUYER_CO, uint64(block.timestamp + 2 days));
        assertEq(ledger.walletCompany(seller), BUYER_CO);
    }

    function test_nonOwnerRevokeReverts() public {
        _bind(SELLER_PK, SELLER_CO);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ledger.revokeWallet(seller);
        assertEq(ledger.walletCompany(seller), SELLER_CO);
    }

    function test_bindReplayReverts() public {
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashBinding(SELLER_CO, seller, deadline);
        bytes memory walletSig = _sign(SELLER_PK, digest);
        bytes memory registrarSig = _sign(REGISTRAR_PK, digest);
        vm.prank(relayer);
        ledger.bindWallet(SELLER_CO, seller, deadline, walletSig, registrarSig);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.DigestUsed.selector, digest));
        ledger.bindWallet(SELLER_CO, seller, deadline, walletSig, registrarSig);
    }
}
