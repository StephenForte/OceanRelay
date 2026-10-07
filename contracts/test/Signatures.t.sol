// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TradingFixture} from "./LedgerFixture.sol";
import {OceanRelayLedger} from "../src/OceanRelayLedger.sol";

contract SignaturesTest is TradingFixture {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function test_domainHelperMatchesContract() public view {
        bytes32 structHash = ledger.structHashPublish(bytes32(uint256(1)), bytes32(uint256(2)), 3, 4);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domain(block.chainid, address(ledger)), structHash));
        assertEq(digest, ledger.hashPublish(bytes32(uint256(1)), bytes32(uint256(2)), 3, 4));
        assertEq(_domain(block.chainid, address(ledger)), ledger.domainSeparator());
    }

    function test_zeroSignatureReverts() public {
        bytes32 offerId = _id();
        vm.expectRevert(OceanRelayLedger.InvalidSignature.selector);
        vm.prank(relayer);
        ledger.publishOffer(offerId, _id(), _expiry(), _deadline(), new bytes(65));
    }

    function test_garbageSignatureReverts() public {
        bytes memory garbage = new bytes(65);
        for (uint256 i; i < garbage.length; ++i) {
            garbage[i] = 0x11;
        }
        vm.expectRevert(OceanRelayLedger.InvalidSignature.selector);
        vm.prank(relayer);
        ledger.publishOffer(_id(), _id(), _expiry(), _deadline(), garbage);

        vm.expectRevert(OceanRelayLedger.InvalidSignature.selector);
        vm.prank(relayer);
        ledger.publishOffer(_id(), _id(), _expiry(), _deadline(), hex"");
    }

    function test_highSSignatureReverts() public {
        bytes32 offerId = _id();
        bytes32 commitment = _id();
        uint64 expiresAt = _expiry();
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashPublish(offerId, commitment, expiresAt, deadline);
        bytes memory sig = _sign(SELLER_PK, digest);
        bytes memory high = _highS(sig);
        vm.expectRevert(OceanRelayLedger.InvalidSignature.selector);
        vm.prank(relayer);
        ledger.publishOffer(offerId, commitment, expiresAt, deadline, high);
        (, uint32 version,,,,) = ledger.getOffer(offerId);
        assertEq(version, 0);
    }

    function test_unboundWalletReverts() public {
        uint256 unboundPk = 0x199;
        address unbound = vm.addr(unboundPk);
        bytes32 offerId = _id();
        bytes32 commitment = _id();
        uint64 expiresAt = _expiry();
        uint64 deadline = _deadline();
        bytes32 digest = ledger.hashPublish(offerId, commitment, expiresAt, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.WalletNotBound.selector, unbound));
        vm.prank(relayer);
        ledger.publishOffer(offerId, commitment, expiresAt, deadline, _sign(unboundPk, digest));
    }

    function test_wrongCompanyReverts() public {
        bytes32 offerId = _id();
        _publish(SELLER_PK, offerId, _id(), _expiry());
        uint64 deadline = _deadline();
        bytes32 commitment = _id();
        uint64 expiresAt = _expiry();
        bytes32 digest = ledger.hashVersion(offerId, 2, commitment, expiresAt, deadline);
        vm.expectRevert(abi.encodeWithSelector(OceanRelayLedger.NotOfferOwner.selector, offerId, BUYER_CO));
        vm.prank(relayer);
        ledger.publishVersion(offerId, 2, commitment, expiresAt, deadline, _sign(BUYER_PK, digest));
    }

    function test_chainIdOneSignatureReverts() public {
        bytes32 offerId = _id();
        bytes32 commitment = _id();
        uint64 expiresAt = _expiry();
        uint64 deadline = _deadline();
        bytes32 structHash = ledger.structHashPublish(offerId, commitment, expiresAt, deadline);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domain(1, address(ledger)), structHash));
        vm.prank(relayer);
        (bool ok,) = address(ledger)
            .call(
                abi.encodeCall(
                    OceanRelayLedger.publishOffer, (offerId, commitment, expiresAt, deadline, _sign(SELLER_PK, digest))
                )
            );
        assertFalse(ok);
        (, uint32 version,,,,) = ledger.getOffer(offerId);
        assertEq(version, 0);
    }

    function test_otherVerifyingContractReverts() public {
        OceanRelayLedger other = new OceanRelayLedger(relayer, registrar);
        bytes32 offerId = _id();
        bytes32 commitment = _id();
        uint64 expiresAt = _expiry();
        uint64 deadline = _deadline();
        bytes32 digest = other.hashPublish(offerId, commitment, expiresAt, deadline);
        vm.prank(relayer);
        (bool ok,) = address(ledger)
            .call(
                abi.encodeCall(
                    OceanRelayLedger.publishOffer, (offerId, commitment, expiresAt, deadline, _sign(SELLER_PK, digest))
                )
            );
        assertFalse(ok);
        (, uint32 version,,,,) = ledger.getOffer(offerId);
        assertEq(version, 0);
    }

    function _domain(uint256 chainId, address verifying) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("OceanRelay")),
                keccak256(bytes("1")),
                chainId,
                verifying
            )
        );
    }

    function _highS(bytes memory sig) internal pure returns (bytes memory) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        bytes32 sHigh = bytes32(SECP256K1_N - uint256(s));
        uint8 vHigh = v == 27 ? 28 : 27;
        return abi.encodePacked(r, sHigh, vHigh);
    }
}
