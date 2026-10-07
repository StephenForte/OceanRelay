// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {OceanRelayLedger} from "../src/OceanRelayLedger.sol";

/// @notice Fails when contracts/vectors/eip712.json drifts from what the contract computes.
/// @dev The signer is Anvil's default account 0, a public test key, not a production key.
contract VectorsTest is Test {
    using stdJson for string;

    address internal constant PIN = address(0x000000000000000000000000000000000000c014);
    uint256 internal constant TEST_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function test_vectorsMatchContract() public {
        OceanRelayLedger deployed = new OceanRelayLedger(address(1), address(2));
        vm.etch(PIN, address(deployed).code);
        vm.chainId(852);
        OceanRelayLedger ledger = OceanRelayLedger(PIN);

        string memory json = vm.readFile("vectors/eip712.json");
        assertEq(json.readString(".domain.name"), "OceanRelay");
        assertEq(json.readString(".domain.version"), "1");
        assertEq(json.readUint(".domain.chainId"), 852);
        assertEq(json.readAddress(".domain.verifyingContract"), PIN);
        assertEq(json.readBytes32(".domain.separator"), ledger.domainSeparator());
        assertEq(json.readAddress(".signer.address"), vm.addr(TEST_KEY));

        _type(json, ledger, "Binding", ledger.BINDING_TYPESTRING(), ledger.BINDING_TYPEHASH());
        _type(json, ledger, "Publish", ledger.PUBLISH_TYPESTRING(), ledger.PUBLISH_TYPEHASH());
        _type(json, ledger, "Version", ledger.VERSION_TYPESTRING(), ledger.VERSION_TYPEHASH());
        _type(json, ledger, "OfferState", ledger.OFFER_STATE_TYPESTRING(), ledger.OFFER_STATE_TYPEHASH());
        _type(json, ledger, "Request", ledger.REQUEST_TYPESTRING(), ledger.REQUEST_TYPEHASH());
        _type(json, ledger, "Acceptance", ledger.ACCEPTANCE_TYPESTRING(), ledger.ACCEPTANCE_TYPEHASH());
        _type(json, ledger, "Status", ledger.STATUS_TYPESTRING(), ledger.STATUS_TYPEHASH());
        _type(json, ledger, "Cancellation", ledger.CANCELLATION_TYPESTRING(), ledger.CANCELLATION_TYPEHASH());

        assertEq(ledger.BINDING_TYPESTRING(), "Binding(bytes32 companyKey,address wallet,uint64 deadline)");
        assertEq(
            ledger.PUBLISH_TYPESTRING(), "Publish(bytes32 offerId,bytes32 commitment,uint64 expiresAt,uint64 deadline)"
        );
        assertEq(
            ledger.VERSION_TYPESTRING(),
            "Version(bytes32 offerId,uint32 version,bytes32 commitment,uint64 expiresAt,uint64 deadline)"
        );
        assertEq(ledger.OFFER_STATE_TYPESTRING(), "OfferState(bytes32 offerId,uint8 state,uint32 seq,uint64 deadline)");
        assertEq(
            ledger.REQUEST_TYPESTRING(), "Request(bytes32 requestId,bytes32 offerId,uint32 version,uint64 deadline)"
        );
        assertEq(
            ledger.ACCEPTANCE_TYPESTRING(),
            "Acceptance(bytes32 requestId,uint32 counter,bytes32 termsCommitment,uint64 deadline)"
        );
        assertEq(ledger.STATUS_TYPESTRING(), "Status(bytes32 requestId,uint8 status,uint32 seq,uint64 deadline)");
        assertEq(ledger.CANCELLATION_TYPESTRING(), "Cancellation(bytes32 requestId,uint64 deadline)");

        {
            bytes32 companyKey = json.readBytes32(".samples.Binding.message.companyKey");
            address wallet = json.readAddress(".samples.Binding.message.wallet");
            uint64 deadline = uint64(json.readUint(".samples.Binding.message.deadline"));
            _check(
                json,
                ".samples.Binding",
                ledger.structHashBinding(companyKey, wallet, deadline),
                ledger.hashBinding(companyKey, wallet, deadline)
            );
        }
        {
            bytes32 offerId = json.readBytes32(".samples.Publish.message.offerId");
            bytes32 commitment = json.readBytes32(".samples.Publish.message.commitment");
            uint64 expiresAt = uint64(json.readUint(".samples.Publish.message.expiresAt"));
            uint64 deadline = uint64(json.readUint(".samples.Publish.message.deadline"));
            _check(
                json,
                ".samples.Publish",
                ledger.structHashPublish(offerId, commitment, expiresAt, deadline),
                ledger.hashPublish(offerId, commitment, expiresAt, deadline)
            );
        }
        {
            bytes32 offerId = json.readBytes32(".samples.Version.message.offerId");
            uint32 version = uint32(json.readUint(".samples.Version.message.version"));
            bytes32 commitment = json.readBytes32(".samples.Version.message.commitment");
            uint64 expiresAt = uint64(json.readUint(".samples.Version.message.expiresAt"));
            uint64 deadline = uint64(json.readUint(".samples.Version.message.deadline"));
            _check(
                json,
                ".samples.Version",
                ledger.structHashVersion(offerId, version, commitment, expiresAt, deadline),
                ledger.hashVersion(offerId, version, commitment, expiresAt, deadline)
            );
        }
        {
            bytes32 offerId = json.readBytes32(".samples.OfferState.message.offerId");
            uint8 state = uint8(json.readUint(".samples.OfferState.message.state"));
            uint32 seq = uint32(json.readUint(".samples.OfferState.message.seq"));
            uint64 deadline = uint64(json.readUint(".samples.OfferState.message.deadline"));
            _check(
                json,
                ".samples.OfferState",
                ledger.structHashOfferState(offerId, state, seq, deadline),
                ledger.hashOfferState(offerId, state, seq, deadline)
            );
        }
        {
            bytes32 requestId = json.readBytes32(".samples.Request.message.requestId");
            bytes32 offerId = json.readBytes32(".samples.Request.message.offerId");
            uint32 version = uint32(json.readUint(".samples.Request.message.version"));
            uint64 deadline = uint64(json.readUint(".samples.Request.message.deadline"));
            _check(
                json,
                ".samples.Request",
                ledger.structHashRequest(requestId, offerId, version, deadline),
                ledger.hashRequest(requestId, offerId, version, deadline)
            );
        }
        {
            bytes32 requestId = json.readBytes32(".samples.Acceptance.message.requestId");
            uint32 counter = uint32(json.readUint(".samples.Acceptance.message.counter"));
            bytes32 terms = json.readBytes32(".samples.Acceptance.message.termsCommitment");
            uint64 deadline = uint64(json.readUint(".samples.Acceptance.message.deadline"));
            _check(
                json,
                ".samples.Acceptance",
                ledger.structHashAcceptance(requestId, counter, terms, deadline),
                ledger.hashAcceptance(requestId, counter, terms, deadline)
            );
        }
        {
            bytes32 requestId = json.readBytes32(".samples.Status.message.requestId");
            uint8 status = uint8(json.readUint(".samples.Status.message.status"));
            uint32 seq = uint32(json.readUint(".samples.Status.message.seq"));
            uint64 deadline = uint64(json.readUint(".samples.Status.message.deadline"));
            _check(
                json,
                ".samples.Status",
                ledger.structHashStatus(requestId, status, seq, deadline),
                ledger.hashStatus(requestId, status, seq, deadline)
            );
        }
        {
            bytes32 requestId = json.readBytes32(".samples.Cancellation.message.requestId");
            uint64 deadline = uint64(json.readUint(".samples.Cancellation.message.deadline"));
            _check(
                json,
                ".samples.Cancellation",
                ledger.structHashCancellation(requestId, deadline),
                ledger.hashCancellation(requestId, deadline)
            );
        }
    }

    function _type(
        string memory json,
        OceanRelayLedger ledger,
        string memory name,
        string memory typeString,
        bytes32 typeHash
    ) internal pure {
        ledger;
        assertEq(json.readString(string.concat(".types.", name, ".typeString")), typeString);
        assertEq(json.readBytes32(string.concat(".types.", name, ".typeHash")), typeHash);
        assertEq(keccak256(bytes(typeString)), typeHash);
    }

    function _check(string memory json, string memory path, bytes32 structHash, bytes32 digest) internal pure {
        assertEq(json.readBytes32(string.concat(path, ".structHash")), structHash);
        assertEq(json.readBytes32(string.concat(path, ".digest")), digest);
        bytes memory signature = json.readBytes(string.concat(path, ".signature"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEST_KEY, digest);
        assertEq(signature, abi.encodePacked(r, s, v));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        assertEq(uint256(err), uint256(ECDSA.RecoverError.NoError));
        assertEq(recovered, vm.addr(TEST_KEY));
    }
}
