// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TradingFixture} from "./LedgerFixture.sol";
import {OceanRelayLedger} from "../src/OceanRelayLedger.sol";

contract MoneyTest is TradingFixture {
    function test_sendingEthReverts() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(ledger).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(ledger).balance, 0);
    }

    function test_unknownSelectorReverts() public {
        (bool ok,) = address(ledger).call(hex"deadbeef");
        assertFalse(ok);
    }

    function test_valueOnKnownFunctionReverts() public {
        (bool ok,) = address(ledger).call{value: 1}(abi.encodeCall(OceanRelayLedger.markExpired, (bytes32(uint256(1)))));
        assertFalse(ok);
        assertEq(address(ledger).balance, 0);
    }

    function test_abiHasNoPayableAndNoCommercialFields() public view {
        string memory json = vm.readFile("out/OceanRelayLedger.sol/OceanRelayLedger.json");
        assertFalse(_contains(json, '"stateMutability":"payable"'));
        assertFalse(_contains(json, '"type":"receive"'));
        assertFalse(_contains(json, '"type":"fallback"'));
        assertFalse(_contains(json, '"name":"price"'));
        assertFalse(_contains(json, '"name":"quantity"'));
        assertFalse(_contains(json, '"name":"margin"'));
        assertFalse(_contains(json, '"name":"companyName"'));
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || h.length < n.length) return false;
        for (uint256 i; i <= h.length - n.length; ++i) {
            bool matched = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) return true;
        }
        return false;
    }
}
