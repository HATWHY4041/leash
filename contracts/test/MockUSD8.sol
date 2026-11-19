// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only 6-decimal token standing in for tUSD8.
contract MockUSD8 {
    mapping(address => uint256) public balanceOf;
    uint8 public constant decimals = 6;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "bal");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}
