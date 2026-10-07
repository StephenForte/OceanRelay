// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployScript} from "../script/Deploy.s.sol";
import {OceanRelayLedger} from "../src/OceanRelayLedger.sol";

contract DeployTest is Test {
    function test_refusesUnknownChain() public {
        DeployScript script = new DeployScript();
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeployScript.UnsupportedChain.selector, uint256(1)));
        script.run();

        vm.chainId(11155111);
        vm.expectRevert(abi.encodeWithSelector(DeployScript.UnsupportedChain.selector, uint256(11155111)));
        script.run();
    }

    /// @dev One test so the environment writes cannot race a parallel test.
    function test_dryRunOnAnvilAndChain852() public {
        address relayerAddr = vm.addr(0xB22);
        address registrarAddr = vm.addr(0xC33);
        address op1 = vm.addr(0xF66);
        address op2 = vm.addr(0xF67);
        vm.chainId(31337);
        vm.setEnv("RELAYER_ADDRESS", vm.toString(relayerAddr));
        vm.setEnv("REGISTRAR_ADDRESS", vm.toString(registrarAddr));
        vm.setEnv("OPERATOR_ADDRESSES", string.concat(vm.toString(op1), ", ", vm.toString(op2)));

        DeployScript script = new DeployScript();
        (OceanRelayLedger ledger, bytes32 runtimeCodeHash) = script.run();

        assertEq(runtimeCodeHash, keccak256(address(ledger).code));
        assertEq(ledger.relayer(), relayerAddr);
        assertEq(ledger.registrar(), registrarAddr);
        assertTrue(ledger.operators(op1));
        assertTrue(ledger.operators(op2));
        assertEq(ledger.owner(), 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38);
        assertEq(block.chainid, 31337);
        assertTrue(runtimeCodeHash != bytes32(0));

        vm.chainId(852);
        vm.setEnv("OPERATOR_ADDRESSES", string(""));
        (OceanRelayLedger on852, bytes32 hash852) = script.run();
        assertEq(hash852, keccak256(address(on852).code));
        assertEq(block.chainid, 852);
        assertFalse(on852.operators(op1));
    }
}
