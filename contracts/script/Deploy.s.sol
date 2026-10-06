// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {OceanRelayLedger} from "../src/OceanRelayLedger.sol";

/// @notice Deploys OceanRelayLedger. The broadcaster is the owner.
/// @dev Reads addresses from the environment only. It never reads or prints a private key.
contract DeployScript is Script {
    error UnsupportedChain(uint256 chainId);

    function run() external returns (OceanRelayLedger ledger, bytes32 runtimeCodeHash) {
        uint256 chainId = block.chainid;
        if (chainId != 852 && chainId != 31337) revert UnsupportedChain(chainId);

        address relayerAddr = vm.envAddress("RELAYER_ADDRESS");
        address registrarAddr = vm.envAddress("REGISTRAR_ADDRESS");
        address[] memory operatorList = _operators();

        vm.startBroadcast();
        ledger = new OceanRelayLedger(relayerAddr, registrarAddr);
        for (uint256 i; i < operatorList.length; ++i) {
            ledger.setOperator(operatorList[i], true);
        }
        vm.stopBroadcast();

        runtimeCodeHash = keccak256(address(ledger).code);
        console2.log("OceanRelayLedger", address(ledger));
        console2.log("owner", ledger.owner());
        console2.log("relayer", relayerAddr);
        console2.log("registrar", registrarAddr);
        console2.log("chainId", chainId);
        if (operatorList.length == 0) {
            console2.log("operators none");
        } else {
            for (uint256 i; i < operatorList.length; ++i) {
                console2.log("operator", operatorList[i]);
            }
        }
        console2.log("runtimeCodeHash");
        console2.logBytes32(runtimeCodeHash);
    }

    function _operators() internal view returns (address[] memory) {
        string memory raw = vm.envOr("OPERATOR_ADDRESSES", string(""));
        bytes memory data = bytes(raw);
        uint256 count;
        uint256 cursor;
        while (cursor < data.length) {
            (uint256 start, uint256 end, uint256 next) = _span(data, cursor);
            if (end > start) ++count;
            cursor = next;
        }
        address[] memory out = new address[](count);
        cursor = 0;
        uint256 idx;
        while (cursor < data.length) {
            (uint256 start, uint256 end, uint256 next) = _span(data, cursor);
            if (end > start) {
                bytes memory slice = new bytes(end - start);
                for (uint256 j; j < slice.length; ++j) {
                    slice[j] = data[start + j];
                }
                out[idx++] = vm.parseAddress(string(slice));
            }
            cursor = next;
        }
        return out;
    }

    function _span(bytes memory data, uint256 cursor) internal pure returns (uint256 start, uint256 end, uint256 next) {
        while (cursor < data.length && (data[cursor] == " " || data[cursor] == "\t")) {
            ++cursor;
        }
        start = cursor;
        while (cursor < data.length && data[cursor] != ",") {
            ++cursor;
        }
        end = cursor;
        while (end > start && (data[end - 1] == " " || data[end - 1] == "\t")) {
            --end;
        }
        next = cursor < data.length ? cursor + 1 : cursor;
    }
}
