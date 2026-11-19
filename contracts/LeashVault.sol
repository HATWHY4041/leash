// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LeashVault
/// @notice A stablecoin wallet that an AI assistant can spend from, but only on a leash.
///         The owner sets the rules on-chain. The AI's key (the "agent") can only:
///           - pay payees the owner has approved,
///           - up to a daily limit,
///           - and anything above the approval threshold becomes a request the owner must approve.
///         Even if the agent key leaks, the worst case is bounded by these rules.
/// @dev Built for Aevum Builder Challenge #1 (QDay Aevum Testnet, tUSD8).

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

contract LeashVault {
    // ---------------------------------------------------------------- types
    enum Status { Pending, Executed, Rejected, Expired }

    struct Payee {
        bool allowed;
        string name;
    }

    struct Request {
        address to;
        uint256 amount;
        string memo;
        Status status;
        uint64 createdAt;
    }

    // ---------------------------------------------------------------- state
    IERC20 public immutable token;
    address public owner;
    address public agent;

    uint256 public dailyLimit;          // max the agent can auto-spend per rolling day
    uint256 public approvalThreshold;   // single payments above this need the owner
    uint256 public constant REQUEST_TTL = 1 days;

    bool public paused;

    uint256 public spentInWindow;
    uint256 public windowStart;

    mapping(address => Payee) public payees;
    mapping(address => bool) private known;
    address[] private payeeList;

    Request[] private requests;

    bool private locked;

    // ---------------------------------------------------------------- events
    event AgentPaid(address indexed to, uint256 amount, string memo, uint256 spentToday);
    event PaymentRequested(uint256 indexed id, address indexed to, uint256 amount, string memo, string reason);
    event RequestApproved(uint256 indexed id, address indexed to, uint256 amount);
    event RequestRejected(uint256 indexed id);
    event PayeeSet(address indexed payee, string name, bool allowed);
    event LimitsChanged(uint256 dailyLimit, uint256 approvalThreshold);
    event AgentChanged(address indexed oldAgent, address indexed newAgent);
    event Paused(bool paused);
    event Withdrawn(address indexed to, uint256 amount);

    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotAgent();
    error IsPaused();
    error PayeeNotApproved();
    error ZeroAmount();
    error BadRequest();
    error TransferFailed();
    error Reentrancy();
    error BadLimits();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    /// @param owner_ the human in control. Passed explicitly so the vault can be deployed by any account
    ///        (e.g. the assistant key paying the gas) while control stays with the owner's wallet.
    constructor(address token_, address owner_, address agent_, uint256 dailyLimit_, uint256 approvalThreshold_) {
        if (approvalThreshold_ > dailyLimit_) revert BadLimits();
        if (owner_ == address(0)) revert BadRequest();
        token = IERC20(token_);
        owner = owner_;
        agent = agent_;
        dailyLimit = dailyLimit_;
        approvalThreshold = approvalThreshold_;
        windowStart = block.timestamp;
        emit AgentChanged(address(0), agent_);
        emit LimitsChanged(dailyLimit_, approvalThreshold_);
    }

    // ================================================================ agent

    /// @notice Called by the AI assistant's key. Pays instantly if every rule passes,
    ///         otherwise files a request for the owner. Never moves more than the rules allow.
    /// @return executed true if paid now, false if it became a request
    /// @return requestId id of the request (only meaningful when executed == false)
    function agentPay(address to, uint256 amount, string calldata memo)
        external
        nonReentrant
        returns (bool executed, uint256 requestId)
    {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert IsPaused();
        if (amount == 0) revert ZeroAmount();
        if (!payees[to].allowed) revert PayeeNotApproved();

        _rollWindow();

        if (amount > approvalThreshold) {
            return (false, _file(to, amount, memo, "above approval threshold"));
        }
        if (spentInWindow + amount > dailyLimit) {
            return (false, _file(to, amount, memo, "would exceed daily limit"));
        }

        spentInWindow += amount;
        _send(to, amount);
        emit AgentPaid(to, amount, memo, spentInWindow);
        return (true, 0);
    }

    // ================================================================ owner

    function approve(uint256 id) external onlyOwner nonReentrant {
        if (id >= requests.length) revert BadRequest();
        Request storage r = requests[id];
        if (r.status != Status.Pending) revert BadRequest();
        if (block.timestamp > r.createdAt + REQUEST_TTL) revert BadRequest(); // expired
        if (!payees[r.to].allowed) revert PayeeNotApproved();
        r.status = Status.Executed;
        _send(r.to, r.amount);
        emit RequestApproved(id, r.to, r.amount);
    }

    function reject(uint256 id) external onlyOwner {
        if (id >= requests.length) revert BadRequest();
        Request storage r = requests[id];
        if (r.status != Status.Pending) revert BadRequest();
        r.status = Status.Rejected;
        emit RequestRejected(id);
    }

    function setPayee(address payee, string calldata name, bool allowed) external onlyOwner {
        if (payee == address(0) || payee == address(this)) revert BadRequest();
        if (!known[payee]) {
            known[payee] = true;
            payeeList.push(payee);
        }
        payees[payee] = Payee(allowed, name);
        emit PayeeSet(payee, name, allowed);
    }

    function setLimits(uint256 dailyLimit_, uint256 approvalThreshold_) external onlyOwner {
        if (approvalThreshold_ > dailyLimit_) revert BadLimits();
        dailyLimit = dailyLimit_;
        approvalThreshold = approvalThreshold_;
        emit LimitsChanged(dailyLimit_, approvalThreshold_);
    }

    /// @notice Rotate or revoke (address(0)) the AI's key.
    function setAgent(address newAgent) external onlyOwner {
        emit AgentChanged(agent, newAgent);
        agent = newAgent;
    }

    /// @notice Kill switch. While paused the agent cannot spend anything.
    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        _send(to, amount);
        emit Withdrawn(to, amount);
    }

    // ================================================================ views

    function remainingToday() public view returns (uint256) {
        uint256 spent = block.timestamp >= windowStart + 1 days ? 0 : spentInWindow;
        return spent >= dailyLimit ? 0 : dailyLimit - spent;
    }

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function getPayees() external view returns (address[] memory addrs, string[] memory names, bool[] memory allowed) {
        uint256 n = payeeList.length;
        addrs = new address[](n);
        names = new string[](n);
        allowed = new bool[](n);
        for (uint256 i; i < n; i++) {
            address a = payeeList[i];
            addrs[i] = a;
            names[i] = payees[a].name;
            allowed[i] = payees[a].allowed;
        }
    }

    function requestCount() external view returns (uint256) {
        return requests.length;
    }

    function getRequest(uint256 id)
        external
        view
        returns (address to, uint256 amount, string memory memo, Status status, uint64 createdAt)
    {
        Request storage r = requests[id];
        Status s = r.status;
        if (s == Status.Pending && block.timestamp > r.createdAt + REQUEST_TTL) s = Status.Expired;
        return (r.to, r.amount, r.memo, s, r.createdAt);
    }

    // ================================================================ internal

    function _rollWindow() internal {
        if (block.timestamp >= windowStart + 1 days) {
            windowStart = block.timestamp;
            spentInWindow = 0;
        }
    }

    function _file(address to, uint256 amount, string calldata memo, string memory reason) internal returns (uint256 id) {
        id = requests.length;
        requests.push(Request(to, amount, memo, Status.Pending, uint64(block.timestamp)));
        emit PaymentRequested(id, to, amount, memo, reason);
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
