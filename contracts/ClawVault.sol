// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ClawVault
 * @notice Trustless escrow for agent-to-agent transactions on Base.
 *         Part of the TrustLayer suite — the trust layer for the agent economy.
 *
 * Flow:
 *   1. Buyer calls createEscrow() → USDC transferred to contract
 *   2. Seller performs service off-chain
 *   3. Seller calls markDelivered() with proof hash
 *   4. Buyer calls acceptDelivery() → USDC released to seller
 *      OR Buyer calls openDispute() → arbiter resolves
 *   5. If buyer doesn't act within acceptanceWindow → seller can claim
 *   6. If seller doesn't deliver by deadline → buyer can reclaim
 *
 * Trust model: Funds held by immutable contract, not by any human.
 *              Arbiter can only route funds to buyer OR seller — never to themselves.
 */
contract ClawVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================
    // TYPES
    // ============================================

    enum Status {
        Active,       // Funded, waiting for seller to deliver
        Delivered,    // Seller marked delivered, waiting for buyer to accept
        Completed,    // Buyer accepted → seller paid
        Disputed,     // Buyer disputed → waiting for arbiter
        Refunded,     // Buyer refunded (deadline passed or dispute won)
        Resolved      // Arbiter resolved dispute
    }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;           // USDC amount (6 decimals)
        uint256 fee;              // Protocol fee held
        bytes32 serviceHash;      // keccak256 of service description
        bytes32 deliveryHash;     // keccak256 of delivery proof (set by seller)
        uint256 deadline;         // Seller must deliver before this timestamp
        uint256 deliveredAt;      // When seller marked delivered
        uint256 acceptanceWindow; // Seconds buyer has to accept/dispute after delivery
        Status status;
        string disputeReason;
    }

    // ============================================
    // STATE
    // ============================================

    IERC20 public immutable usdc;
    address public arbiter;           // Can resolve disputes (TrustLayer multisig or DAO)
    address public feeRecipient;      // Receives protocol fees
    uint256 public feeBps;            // Fee in basis points (e.g., 100 = 1%)
    uint256 public constant MAX_FEE = 500; // Max 5%
    uint256 public constant MIN_ACCEPTANCE_WINDOW = 1 hours;
    uint256 public constant MAX_ACCEPTANCE_WINDOW = 7 days;

    uint256 public nextEscrowId;
    mapping(uint256 => Escrow) public escrows;

    // Stats
    uint256 public totalEscrowsCreated;
    uint256 public totalVolumeUsdc;
    uint256 public totalFeesCollected;

    // ============================================
    // EVENTS
    // ============================================

    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 deadline,
        bytes32 serviceHash
    );
    event DeliveryMarked(uint256 indexed escrowId, bytes32 deliveryHash);
    event DeliveryAccepted(uint256 indexed escrowId, uint256 amountToSeller);
    event DisputeOpened(uint256 indexed escrowId, string reason);
    event DisputeResolved(uint256 indexed escrowId, address winner, uint256 amount);
    event EscrowRefunded(uint256 indexed escrowId, uint256 amountToBuyer);
    event EscrowClaimedByTimeout(uint256 indexed escrowId, uint256 amountToSeller);
    event ArbiterUpdated(address oldArbiter, address newArbiter);
    event FeeUpdated(uint256 oldFee, uint256 newFee);

    // ============================================
    // MODIFIERS
    // ============================================

    modifier onlyBuyer(uint256 _id) {
        require(msg.sender == escrows[_id].buyer, "Not buyer");
        _;
    }

    modifier onlySeller(uint256 _id) {
        require(msg.sender == escrows[_id].seller, "Not seller");
        _;
    }

    modifier onlyArbiter() {
        require(msg.sender == arbiter, "Not arbiter");
        _;
    }

    // ============================================
    // CONSTRUCTOR
    // ============================================

    /**
     * @param _usdc USDC contract address on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
     * @param _arbiter Address that can resolve disputes (start with deployer, migrate to multisig/DAO)
     * @param _feeRecipient Address that receives protocol fees
     * @param _feeBps Protocol fee in basis points (e.g., 100 = 1%)
     */
    constructor(address _usdc, address _arbiter, address _feeRecipient, uint256 _feeBps) {
        require(_usdc != address(0), "Invalid USDC");
        require(_arbiter != address(0), "Invalid arbiter");
        require(_feeRecipient != address(0), "Invalid fee recipient");
        require(_feeBps <= MAX_FEE, "Fee too high");

        usdc = IERC20(_usdc);
        arbiter = _arbiter;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
    }

    // ============================================
    // CORE ESCROW LIFECYCLE
    // ============================================

    /**
     * @notice Create and fund an escrow. Buyer must approve USDC first.
     * @param _seller Address of the service provider
     * @param _amount USDC amount (6 decimals, e.g., 10_000000 = $10)
     * @param _serviceHash keccak256 of the service description (for on-chain proof)
     * @param _deadlineSeconds Seconds from now until delivery deadline
     * @param _acceptanceWindowSeconds Seconds buyer has to accept after delivery (min 1h, max 7d)
     */
    function createEscrow(
        address _seller,
        uint256 _amount,
        bytes32 _serviceHash,
        uint256 _deadlineSeconds,
        uint256 _acceptanceWindowSeconds
    ) external nonReentrant returns (uint256 escrowId) {
        require(_seller != address(0) && _seller != msg.sender, "Invalid seller");
        require(_amount > 0, "Amount must be > 0");
        require(_deadlineSeconds >= 1 hours, "Deadline too short");
        require(_deadlineSeconds <= 90 days, "Deadline too long");
        require(
            _acceptanceWindowSeconds >= MIN_ACCEPTANCE_WINDOW &&
            _acceptanceWindowSeconds <= MAX_ACCEPTANCE_WINDOW,
            "Invalid acceptance window"
        );

        // Calculate fee
        uint256 fee = (_amount * feeBps) / 10000;
        uint256 total = _amount + fee;

        // Transfer USDC from buyer to contract
        usdc.safeTransferFrom(msg.sender, address(this), total);

        escrowId = nextEscrowId++;
        escrows[escrowId] = Escrow({
            buyer: msg.sender,
            seller: _seller,
            amount: _amount,
            fee: fee,
            serviceHash: _serviceHash,
            deliveryHash: bytes32(0),
            deadline: block.timestamp + _deadlineSeconds,
            deliveredAt: 0,
            acceptanceWindow: _acceptanceWindowSeconds,
            status: Status.Active,
            disputeReason: ""
        });

        totalEscrowsCreated++;
        totalVolumeUsdc += _amount;

        emit EscrowCreated(escrowId, msg.sender, _seller, _amount, escrows[escrowId].deadline, _serviceHash);
    }

    /**
     * @notice Seller marks the service as delivered with proof hash.
     * @param _escrowId The escrow ID
     * @param _deliveryHash keccak256 of delivery proof (IPFS CID, tx hash, API response hash, etc.)
     */
    function markDelivered(uint256 _escrowId, bytes32 _deliveryHash) external onlySeller(_escrowId) {
        Escrow storage e = escrows[_escrowId];
        require(e.status == Status.Active, "Not active");
        require(block.timestamp <= e.deadline, "Deadline passed");
        require(_deliveryHash != bytes32(0), "Empty proof");

        e.deliveryHash = _deliveryHash;
        e.deliveredAt = block.timestamp;
        e.status = Status.Delivered;

        emit DeliveryMarked(_escrowId, _deliveryHash);
    }

    /**
     * @notice Buyer accepts delivery → USDC released to seller.
     */
    function acceptDelivery(uint256 _escrowId) external onlyBuyer(_escrowId) nonReentrant {
        Escrow storage e = escrows[_escrowId];
        require(e.status == Status.Delivered, "Not delivered");

        e.status = Status.Completed;

        // Pay seller
        usdc.safeTransfer(e.seller, e.amount);
        // Pay protocol fee
        if (e.fee > 0) {
            usdc.safeTransfer(feeRecipient, e.fee);
            totalFeesCollected += e.fee;
        }

        emit DeliveryAccepted(_escrowId, e.amount);
    }

    /**
     * @notice Buyer disputes delivery within acceptance window.
     */
    function openDispute(uint256 _escrowId, string calldata _reason) external onlyBuyer(_escrowId) {
        Escrow storage e = escrows[_escrowId];
        require(e.status == Status.Delivered, "Not delivered");
        require(
            block.timestamp <= e.deliveredAt + e.acceptanceWindow,
            "Acceptance window expired"
        );
        require(bytes(_reason).length > 0, "Reason required");

        e.status = Status.Disputed;
        e.disputeReason = _reason;

        emit DisputeOpened(_escrowId, _reason);
    }

    /**
     * @notice Arbiter resolves dispute. Can only send to buyer or seller.
     * @param _escrowId The escrow ID
     * @param _buyerWins True = refund buyer, False = pay seller
     */
    function resolveDispute(uint256 _escrowId, bool _buyerWins) external onlyArbiter nonReentrant {
        Escrow storage e = escrows[_escrowId];
        require(e.status == Status.Disputed, "Not disputed");

        e.status = Status.Resolved;

        if (_buyerWins) {
            // Refund buyer (amount + fee)
            usdc.safeTransfer(e.buyer, e.amount + e.fee);
            emit DisputeResolved(_escrowId, e.buyer, e.amount + e.fee);
        } else {
            // Pay seller
            usdc.safeTransfer(e.seller, e.amount);
            if (e.fee > 0) {
                usdc.safeTransfer(feeRecipient, e.fee);
                totalFeesCollected += e.fee;
            }
            emit DisputeResolved(_escrowId, e.seller, e.amount);
        }
    }

    // ============================================
    // TIMEOUT CLAIMS
    // ============================================

    /**
     * @notice Buyer reclaims if seller didn't deliver by deadline.
     */
    function reclaimExpired(uint256 _escrowId) external onlyBuyer(_escrowId) nonReentrant {
        Escrow storage e = escrows[_escrowId];
        require(e.status == Status.Active, "Not active");
        require(block.timestamp > e.deadline, "Deadline not passed");

        e.status = Status.Refunded;
        // Full refund including fee
        usdc.safeTransfer(e.buyer, e.amount + e.fee);

        emit EscrowRefunded(_escrowId, e.amount + e.fee);
    }

    /**
     * @notice Seller claims if buyer didn't accept/dispute within acceptance window.
     */
    function claimByTimeout(uint256 _escrowId) external onlySeller(_escrowId) nonReentrant {
        Escrow storage e = escrows[_escrowId];
        require(e.status == Status.Delivered, "Not delivered");
        require(
            block.timestamp > e.deliveredAt + e.acceptanceWindow,
            "Acceptance window not expired"
        );

        e.status = Status.Completed;

        usdc.safeTransfer(e.seller, e.amount);
        if (e.fee > 0) {
            usdc.safeTransfer(feeRecipient, e.fee);
            totalFeesCollected += e.fee;
        }

        emit EscrowClaimedByTimeout(_escrowId, e.amount);
    }

    // ============================================
    // VIEWS
    // ============================================

    function getEscrow(uint256 _escrowId) external view returns (Escrow memory) {
        return escrows[_escrowId];
    }

    function getStats() external view returns (
        uint256 _totalCreated,
        uint256 _totalVolume,
        uint256 _totalFees,
        uint256 _nextId
    ) {
        return (totalEscrowsCreated, totalVolumeUsdc, totalFeesCollected, nextEscrowId);
    }

    /**
     * @notice Check if an escrow can be reclaimed by buyer (deadline passed, no delivery).
     */
    function canReclaim(uint256 _escrowId) external view returns (bool) {
        Escrow storage e = escrows[_escrowId];
        return e.status == Status.Active && block.timestamp > e.deadline;
    }

    /**
     * @notice Check if seller can claim by timeout (acceptance window expired).
     */
    function canClaimByTimeout(uint256 _escrowId) external view returns (bool) {
        Escrow storage e = escrows[_escrowId];
        return e.status == Status.Delivered && block.timestamp > e.deliveredAt + e.acceptanceWindow;
    }

    // ============================================
    // ADMIN (minimal — only arbiter + fee management)
    // ============================================

    function updateArbiter(address _newArbiter) external onlyArbiter {
        require(_newArbiter != address(0), "Invalid");
        emit ArbiterUpdated(arbiter, _newArbiter);
        arbiter = _newArbiter;
    }

    function updateFee(uint256 _newFeeBps) external onlyArbiter {
        require(_newFeeBps <= MAX_FEE, "Too high");
        emit FeeUpdated(feeBps, _newFeeBps);
        feeBps = _newFeeBps;
    }

    function updateFeeRecipient(address _newRecipient) external onlyArbiter {
        require(_newRecipient != address(0), "Invalid");
        feeRecipient = _newRecipient;
    }
}
