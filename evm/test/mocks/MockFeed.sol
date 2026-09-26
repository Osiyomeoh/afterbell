// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice A Chainlink proxy stand-in: round ids carry the phase in their top 16 bits, and asking for a
/// round that doesn't exist reverts, as the real proxies do.
contract MockFeed {
    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 public immutable decimals;
    uint16 public phase = 1;
    uint64 public aggregatorRound;
    mapping(uint80 => Round) private rounds;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function push(int256 answer, uint256 updatedAt) external returns (uint80 id) {
        id = (uint80(phase) << 64) | ++aggregatorRound;
        rounds[id] = Round(answer, updatedAt);
    }

    /// @notice Start a new phase (Chainlink swaps the aggregator behind the proxy).
    function nextPhase() external {
        phase++;
        aggregatorRound = 0;
    }

    function latestRound() public view returns (uint80) {
        return (uint80(phase) << 64) | aggregatorRound;
    }

    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[id];
        require(r.updatedAt != 0, "No data present");
        return (id, r.answer, r.updatedAt, r.updatedAt, id);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint80 id = latestRound();
        Round memory r = rounds[id];
        return (id, r.answer, r.updatedAt, r.updatedAt, id);
    }
}
