// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {OceanRelayLedger} from "../src/OceanRelayLedger.sol";

/// @notice Writes contracts/vectors/eip712.json from the contract's own EIP-712 hashes.
/// @dev The signing key is Anvil's default account 0. It is a public test key, not a production key.
contract GenerateVectors is Script {
    address internal constant PIN = address(0x000000000000000000000000000000000000c014);
    uint256 internal constant TEST_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    bytes32 internal constant COMPANY_KEY = hex"1111111111111111111111111111111111111111111111111111111111111111";
    bytes32 internal constant OFFER_ID = hex"2222222222222222222222222222222222222222222222222222222222222222";
    bytes32 internal constant COMMITMENT = hex"3333333333333333333333333333333333333333333333333333333333333333";
    bytes32 internal constant REQUEST_ID = hex"4444444444444444444444444444444444444444444444444444444444444444";
    bytes32 internal constant TERMS = hex"5555555555555555555555555555555555555555555555555555555555555555";
    uint64 internal constant DEADLINE = 1_893_456_000;
    uint64 internal constant EXPIRES_AT = 1_893_456_000;
    uint32 internal constant VERSION = 2;
    uint8 internal constant STATE = 1;
    uint32 internal constant OFFER_SEQ = 7;
    uint32 internal constant REQUEST_VERSION = 3;
    uint32 internal constant COUNTER = 4;
    uint8 internal constant STATUS = 3;
    uint32 internal constant STATUS_SEQ = 8;

    function run() external {
        OceanRelayLedger deployed = new OceanRelayLedger(address(1), address(2));
        vm.etch(PIN, address(deployed).code);
        vm.chainId(852);
        OceanRelayLedger ledger = OceanRelayLedger(PIN);
        address signer = vm.addr(TEST_KEY);

        string memory types = string.concat(
            _type("Binding", ledger.BINDING_TYPESTRING(), ledger.BINDING_TYPEHASH()),
            ",",
            _type("Publish", ledger.PUBLISH_TYPESTRING(), ledger.PUBLISH_TYPEHASH()),
            ",",
            _type("Version", ledger.VERSION_TYPESTRING(), ledger.VERSION_TYPEHASH()),
            ",",
            _type("OfferState", ledger.OFFER_STATE_TYPESTRING(), ledger.OFFER_STATE_TYPEHASH())
        );
        types = string.concat(
            types,
            ",",
            _type("Request", ledger.REQUEST_TYPESTRING(), ledger.REQUEST_TYPEHASH()),
            ",",
            _type("Acceptance", ledger.ACCEPTANCE_TYPESTRING(), ledger.ACCEPTANCE_TYPEHASH()),
            ",",
            _type("Status", ledger.STATUS_TYPESTRING(), ledger.STATUS_TYPEHASH()),
            ",",
            _type("Cancellation", ledger.CANCELLATION_TYPESTRING(), ledger.CANCELLATION_TYPEHASH())
        );
        string memory samples = string.concat(_binding(ledger, signer), ",", _publish(ledger), ",", _version(ledger));
        samples = string.concat(samples, ",", _offerState(ledger), ",", _request(ledger), ",", _acceptance(ledger));
        samples = string.concat(samples, ",", _status(ledger), ",", _cancellation(ledger));
        string memory json = string.concat(
            '{"domain":{"name":"OceanRelay","version":"1","chainId":852,"verifyingContract":"',
            Strings.toHexString(PIN),
            '","separator":"',
            Strings.toHexString(uint256(ledger.domainSeparator()), 32),
            '"},"signer":{"address":"',
            Strings.toHexString(signer),
            '","privateKey":"',
            Strings.toHexString(TEST_KEY, 32),
            '","label":"Anvil default account 0. Test only. Never use for real funds."},"types":{',
            types,
            '},"samples":{',
            samples,
            "}}"
        );
        vm.writeFile("vectors/eip712.json", json);
    }

    function _binding(OceanRelayLedger ledger, address signer) internal view returns (string memory) {
        bytes32 structHash = ledger.structHashBinding(COMPANY_KEY, signer, DEADLINE);
        bytes32 digest = ledger.hashBinding(COMPANY_KEY, signer, DEADLINE);
        string memory message = string.concat(
            '{"companyKey":"',
            Strings.toHexString(uint256(COMPANY_KEY), 32),
            '","wallet":"',
            Strings.toHexString(signer),
            '","deadline":',
            Strings.toString(DEADLINE),
            "}"
        );
        return _sample("Binding", message, structHash, digest);
    }

    function _publish(OceanRelayLedger ledger) internal view returns (string memory) {
        bytes32 structHash = ledger.structHashPublish(OFFER_ID, COMMITMENT, EXPIRES_AT, DEADLINE);
        bytes32 digest = ledger.hashPublish(OFFER_ID, COMMITMENT, EXPIRES_AT, DEADLINE);
        string memory message = string.concat(
            '{"offerId":"',
            _b32(OFFER_ID),
            '","commitment":"',
            _b32(COMMITMENT),
            '","expiresAt":',
            Strings.toString(EXPIRES_AT),
            ',"deadline":',
            Strings.toString(DEADLINE),
            "}"
        );
        return _sample("Publish", message, structHash, digest);
    }

    function _version(OceanRelayLedger ledger) internal view returns (string memory) {
        bytes32 structHash = ledger.structHashVersion(OFFER_ID, VERSION, COMMITMENT, EXPIRES_AT, DEADLINE);
        bytes32 digest = ledger.hashVersion(OFFER_ID, VERSION, COMMITMENT, EXPIRES_AT, DEADLINE);
        string memory message = string.concat(
            '{"offerId":"',
            _b32(OFFER_ID),
            '","version":',
            Strings.toString(VERSION),
            ',"commitment":"',
            _b32(COMMITMENT),
            '","expiresAt":',
            Strings.toString(EXPIRES_AT),
            ',"deadline":',
            Strings.toString(DEADLINE),
            "}"
        );
        return _sample("Version", message, structHash, digest);
    }

    function _offerState(OceanRelayLedger ledger) internal view returns (string memory) {
        bytes32 structHash = ledger.structHashOfferState(OFFER_ID, STATE, OFFER_SEQ, DEADLINE);
        bytes32 digest = ledger.hashOfferState(OFFER_ID, STATE, OFFER_SEQ, DEADLINE);
        string memory message = string.concat(
            '{"offerId":"',
            _b32(OFFER_ID),
            '","state":',
            Strings.toString(STATE),
            ',"seq":',
            Strings.toString(OFFER_SEQ),
            ',"deadline":',
            Strings.toString(DEADLINE),
            "}"
        );
        return _sample("OfferState", message, structHash, digest);
    }

    function _request(OceanRelayLedger ledger) internal view returns (string memory) {
        bytes32 structHash = ledger.structHashRequest(REQUEST_ID, OFFER_ID, REQUEST_VERSION, DEADLINE);
        bytes32 digest = ledger.hashRequest(REQUEST_ID, OFFER_ID, REQUEST_VERSION, DEADLINE);
        string memory message = string.concat(
            '{"requestId":"',
            _b32(REQUEST_ID),
            '","offerId":"',
            _b32(OFFER_ID),
            '","version":',
            Strings.toString(REQUEST_VERSION),
            ',"deadline":',
            Strings.toString(DEADLINE),
            "}"
        );
        return _sample("Request", message, structHash, digest);
    }

    function _acceptance(OceanRelayLedger ledger) internal view returns (string memory) {
        bytes32 structHash = ledger.structHashAcceptance(REQUEST_ID, COUNTER, TERMS, DEADLINE);
        bytes32 digest = ledger.hashAcceptance(REQUEST_ID, COUNTER, TERMS, DEADLINE);
        string memory message = string.concat(
            '{"requestId":"',
            _b32(REQUEST_ID),
            '","counter":',
            Strings.toString(COUNTER),
            ',"termsCommitment":"',
            _b32(TERMS),
            '","deadline":',
            Strings.toString(DEADLINE),
            "}"
        );
        return _sample("Acceptance", message, structHash, digest);
    }

    function _status(OceanRelayLedger ledger) internal view returns (string memory) {
        bytes32 structHash = ledger.structHashStatus(REQUEST_ID, STATUS, STATUS_SEQ, DEADLINE);
        bytes32 digest = ledger.hashStatus(REQUEST_ID, STATUS, STATUS_SEQ, DEADLINE);
        string memory message = string.concat(
            '{"requestId":"',
            _b32(REQUEST_ID),
            '","status":',
            Strings.toString(STATUS),
            ',"seq":',
            Strings.toString(STATUS_SEQ),
            ',"deadline":',
            Strings.toString(DEADLINE),
            "}"
        );
        return _sample("Status", message, structHash, digest);
    }

    function _cancellation(OceanRelayLedger ledger) internal view returns (string memory) {
        bytes32 structHash = ledger.structHashCancellation(REQUEST_ID, DEADLINE);
        bytes32 digest = ledger.hashCancellation(REQUEST_ID, DEADLINE);
        string memory message =
            string.concat('{"requestId":"', _b32(REQUEST_ID), '","deadline":', Strings.toString(DEADLINE), "}");
        return _sample("Cancellation", message, structHash, digest);
    }

    function _sample(string memory name, string memory message, bytes32 structHash, bytes32 digest)
        internal
        pure
        returns (string memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TEST_KEY, digest);
        bytes memory signature = abi.encodePacked(r, s, v);
        return string.concat(
            '"',
            name,
            '":{"message":',
            message,
            ',"structHash":"',
            _b32(structHash),
            '","digest":"',
            _b32(digest),
            '","signature":"',
            Strings.toHexString(signature),
            '"}'
        );
    }

    function _type(string memory name, string memory typeString, bytes32 typeHash)
        internal
        pure
        returns (string memory)
    {
        return string.concat('"', name, '":{"typeString":"', typeString, '","typeHash":"', _b32(typeHash), '"}');
    }

    function _b32(bytes32 value) internal pure returns (string memory) {
        return Strings.toHexString(uint256(value), 32);
    }
}
