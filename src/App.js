import React from "react";
import Web3 from "web3";
import { CONTRACT_ABI, CONTRACT_ADDRESS } from "./contract";

const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";

class App extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      status: "",
      currentAccount: "",
      owner: "",
      contractBalanceEth: "0",
      collectedFeesEth: "0",
      auctionFeeEth: "0",
      currentBlock: "",
      destroyed: false,

      activeAuctions: [],
      completedAuctions: [],
      cancelledAuctions: [],

      claimEnabled: false,
      claimAmountEth: "0",

      newTitle: "Test Auction 1",
      newStartPriceEth: "0.001",
      newDurationBlocks: "500",

      bidInputs: {},

      adminNewOwner: "",
      adminBanSeller: "",
    };

    this.web3 = null;
    this.contract = null;

    this.subscriptionId = null;
    this.onEthMessage = null;

    this.eventSubs = [];
    this.refreshInProgress = false;
  }

  componentDidMount() {
    this.init();
  }

  componentWillUnmount() {
    try {
      if (window.ethereum && this.onEthMessage) {
        window.ethereum.removeListener("message", this.onEthMessage);
      }
      if (window.ethereum && this.subscriptionId) {
        window.ethereum.request({
          method: "eth_unsubscribe",
          params: [this.subscriptionId],
        });
      }
    } catch (e) {}

    try {
      for (const s of this.eventSubs) {
        if (s && typeof s.unsubscribe === "function") s.unsubscribe();
      }
    } catch (e) {}
  }

  init = async () => {
    try {
      if (!window.ethereum) {
        alert("Παρακαλώ εγκατέστησε MetaMask.");
        return;
      }

      await window.ethereum.request({ method: "eth_requestAccounts" });

      const chainId = await window.ethereum.request({ method: "eth_chainId" });
      if (chainId !== SEPOLIA_CHAIN_ID_HEX) {
        alert("Βάλε MetaMask σε Sepolia και κάνε refresh.");
        return;
      }

      this.web3 = new Web3(window.ethereum);

      const accounts = await this.web3.eth.getAccounts();
      const acc = accounts && accounts.length ? accounts[0] : "";

      this.contract = new this.web3.eth.Contract(CONTRACT_ABI, CONTRACT_ADDRESS);

      // Basic sanity: αν στο address δεν υπάρχει code, ABI/Address είναι λάθος
      const code = await this.web3.eth.getCode(CONTRACT_ADDRESS);
      if (!code || code === "0x") {
        alert("Σφάλμα: Δεν υπάρχει contract στο CONTRACT_ADDRESS (λάθος address).");
        return;
      }

      this.setState(
        { currentAccount: acc, status: "Connected to Sepolia" },
        async () => {
          await this.refreshAll();
          this.setupMetamaskListeners();
          this.setupEventSync();
          await this.setupNewHeadsSubscription();
        }
      );
    } catch (e) {
      console.error("INIT ERROR:", e);
      alert("INIT ERROR: " + (e?.message || e));
    }
  };

  setupMetamaskListeners = () => {
    if (!window.ethereum) return;

    window.ethereum.on("accountsChanged", async (accounts) => {
      const acc = accounts && accounts.length ? accounts[0] : "";
      this.setState({ currentAccount: acc }, async () => {
        await this.refreshAll();
      });
    });

    window.ethereum.on("chainChanged", () => {
      window.location.reload();
    });
  };

  setupEventSync = () => {
    if (!this.contract) return;

    // Καθαρίζουμε τυχόν παλιές subscriptions
    try {
      for (const s of this.eventSubs) {
        if (s && typeof s.unsubscribe === "function") s.unsubscribe();
      }
    } catch (e) {}
    this.eventSubs = [];

    const attach = (eventName, handler) => {
      try {
        if (!this.contract.events || !this.contract.events[eventName]) return;
        const sub = this.contract.events[eventName]({}).on("data", handler).on("error", () => {});
        this.eventSubs.push(sub);
      } catch (e) {}
    };

    const onAnyChange = async () => {
      await this.refreshAll();
    };

    // Αυτά είναι τα πιο συνηθισμένα από την εργασία/ABI σου
    attach("AuctionCreated", onAnyChange);
    attach("BidPlaced", onAnyChange);
    attach("AuctionCancelled", onAnyChange);
    attach("AuctionFulfilled", onAnyChange);
    attach("OwnerChanged", onAnyChange);
    attach("SellerBanned", onAnyChange);
    attach("Withdraw", onAnyChange);
    attach("ClaimPaid", onAnyChange);
    attach("ContractDestroyed", onAnyChange);
  };

  setupNewHeadsSubscription = async () => {
    try {
      if (!window.ethereum) return;

      // eth_subscribe είναι ο σωστός τρόπος με MetaMask provider (όχι web3.eth.subscribe)
      this.subscriptionId = await window.ethereum.request({
        method: "eth_subscribe",
        params: ["newHeads"],
      });

      this.onEthMessage = async (message) => {
        try {
          if (!message || message.type !== "eth_subscription") return;
          if (!message.data || message.data.subscription !== this.subscriptionId) return;

          const head = message.data.result;
          if (head && head.number) {
            const bn = parseInt(head.number, 16);
            if (!Number.isNaN(bn)) {
              this.setState({ currentBlock: String(bn) });
              // Δεν κάνουμε refresh κάθε block με βαρύ τρόπο.
              // Αλλά αν θέλεις, μπορείς να ξεκλειδώνεις Fulfill/Blocks left live.
              // Auctions reload γίνεται ήδη με events.
            }
          }
        } catch (e) {}
      };

      window.ethereum.on("message", this.onEthMessage);

      // Αρχικό block
      const b = await this.web3.eth.getBlockNumber();
      this.setState({ currentBlock: String(b) });
    } catch (e) {
      // Αν ο RPC δεν υποστηρίζει subscriptions, δεν σπάμε την εφαρμογή.
      console.warn("newHeads not supported:", e?.message || e);
    }
  };

  refreshAll = async () => {
    if (this.refreshInProgress) return;
    this.refreshInProgress = true;
    try {
      await this.refreshTop();
      await this.loadAuctions();
      await this.refreshClaimStatus();
    } finally {
      this.refreshInProgress = false;
    }
  };

  refreshTop = async () => {
    try {
      if (!this.web3 || !this.contract) return;

      const owner = await this.safeCallOwner();
      const balWei = await this.web3.eth.getBalance(CONTRACT_ADDRESS);
      const balEth = this.web3.utils.fromWei(String(balWei), "ether");

      const collectedFeesEth = await this.safeCallCollectedFeesEth();
      const auctionFeeEth = await this.safeCallAuctionFeeEth();
      const destroyed = await this.safeCallDestroyed();

      const currentBlock = await this.web3.eth.getBlockNumber();

      this.setState({
        owner: owner || "",
        contractBalanceEth: balEth || "0",
        collectedFeesEth: collectedFeesEth || "0",
        auctionFeeEth: auctionFeeEth || "0",
        destroyed: !!destroyed,
        currentBlock: String(currentBlock),
      });
    } catch (e) {
      console.error("REFRESH TOP ERROR:", e);
    }
  };

  safeCallOwner = async () => {
    try {
      if (this.contract.methods.PERMANENT_ADMIN) {
        return await this.contract.methods.PERMANENT_ADMIN().call();
      }
      if (this.contract.methods.owner) {
        return await this.contract.methods.owner().call();
      }
      return "";
    } catch (e) {
      return "";
    }
  };

  safeCallCollectedFeesEth = async () => {
    try {
      if (this.contract.methods.getWithdrawable) {
        const wWei = await this.contract.methods.getWithdrawable().call();
        return this.web3.utils.fromWei(String(wWei), "ether");
      }
      // fallback
      return "0";
    } catch (e) {
      return "0";
    }
  };

  safeCallAuctionFeeEth = async () => {
    try {
      if (this.contract.methods.AUCTION_FEE) {
        const fWei = await this.contract.methods.AUCTION_FEE().call();
        return this.web3.utils.fromWei(String(fWei), "ether");
      }
      if (this.contract.methods.auctionFee) {
        const fWei = await this.contract.methods.auctionFee().call();
        return this.web3.utils.fromWei(String(fWei), "ether");
      }
      // Αν δεν υπάρχει στο contract, βάλε default (μπορείς να το αλλάξεις)
      return "0.02";
    } catch (e) {
      return "0.02";
    }
  };

  safeCallDestroyed = async () => {
    try {
      if (this.contract.methods.destroyed) {
        return await this.contract.methods.destroyed().call();
      }
      return false;
    } catch (e) {
      return false;
    }
  };

  safeIsBannedSeller = async (addr) => {
    try {
      if (!addr) return false;
      if (this.contract.methods.bannedSellers) {
        return await this.contract.methods.bannedSellers(addr).call();
      }
      return false;
    } catch (e) {
      return false;
    }
  };

  loadAuctions = async () => {
    try {
      if (!this.contract) return;

      const getIds = async (fnName) => {
        if (!this.contract.methods[fnName]) return [];
        const ids = await this.contract.methods[fnName]().call();
        return Array.isArray(ids) ? ids.map((x) => String(x)) : [];
      };

      // ΠΡΟΣΟΧΗ: εδώ πρέπει τα ονόματα να ταιριάζουν με το ABI σου
      const activeIds = await getIds("getActiveAuctions");
      const cancelledIds = await getIds("getCancelledAuctions");
      const completedIds = await getIds("getCompletedAuctions");

      const mapAuction = async (id) => {
        const a = await this.contract.methods.auctions(id).call();
        // Αναμένουμε fields σαν αυτά που είχες ήδη: title, seller, startPrice, endBlock, highestBid, highestBidder, state
        return {
          id: String(a.id ?? id),
          title: a.title || "",
          seller: a.seller || "",
          startPriceWei: String(a.startPrice || "0"),
          endBlock: String(a.endBlock || "0"),
          highestBidWei: String(a.highestBid || "0"),
          highestBidder: a.highestBidder || "0x0000000000000000000000000000000000000000",
          state: a.state !== undefined ? String(a.state) : "",
        };
      };

      const activeAuctions = await Promise.all(activeIds.map(mapAuction));
      const cancelledAuctions = await Promise.all(cancelledIds.map(mapAuction));
      const completedAuctions = await Promise.all(completedIds.map(mapAuction));

      this.setState({ activeAuctions, cancelledAuctions, completedAuctions });
    } catch (e) {
      console.error("LOAD AUCTIONS ERROR:", e);
      alert("LOAD AUCTIONS ERROR: " + (e?.message || e));
    }
  };

  refreshClaimStatus = async () => {
    try {
      if (!this.contract || !this.state.currentAccount) {
        this.setState({ claimEnabled: false, claimAmountEth: "0" });
        return;
      }

      // βρίσκουμε pending returns για τον τρέχοντα χρήστη
      let pendingWei = "0";

      if (this.contract.methods.pendingReturns) {
        pendingWei = await this.contract.methods.pendingReturns(this.state.currentAccount).call();
      } else if (this.contract.methods.getPendingReturns) {
        pendingWei = await this.contract.methods.getPendingReturns(this.state.currentAccount).call();
      }

      const pendingEth = this.web3.utils.fromWei(String(pendingWei), "ether");
      const enabled = String(pendingWei) !== "0";

      this.setState({ claimEnabled: enabled, claimAmountEth: pendingEth });
    } catch (e) {
      // αν το contract δεν έχει pendingReturns, απλά το κρατάμε off
      this.setState({ claimEnabled: false, claimAmountEth: "0" });
    }
  };

  onChange = (key) => (e) => this.setState({ [key]: e.target.value });

  setBidInput = (auctionId, value) => {
    this.setState((prev) => ({
      bidInputs: { ...prev.bidInputs, [auctionId]: value },
    }));
  };

  createAuction = async () => {
    try {
      if (!this.contract || !this.web3) return;

      const { currentAccount, owner, destroyed, newTitle, newStartPriceEth, newDurationBlocks } =
        this.state;

      if (!currentAccount) return;

      if (owner && currentAccount.toLowerCase() === owner.toLowerCase()) {
        alert("Ο owner δεν επιτρέπεται να δημιουργεί δημοπρασίες.");
        return;
      }

      if (destroyed) {
        alert("Το contract είναι σε κατάσταση Destroy. Δεν επιτρέπονται νέες δημοπρασίες.");
        return;
      }

      const banned = await this.safeIsBannedSeller(currentAccount);
      if (banned) {
        alert("Η διεύθυνσή σου είναι στη banned list.");
        return;
      }

      if (!newTitle || !newTitle.trim()) {
        alert("Βάλε τίτλο.");
        return;
      }

      const startPriceWei = this.web3.utils.toWei(String(newStartPriceEth || "0"), "ether");
      const durationBlocks = parseInt(String(newDurationBlocks || "0"), 10);
      if (!durationBlocks || durationBlocks < 1) {
        alert("Duration blocks πρέπει να είναι >= 1.");
        return;
      }

      // fee
      let feeWei = null;
      if (this.contract.methods.AUCTION_FEE) feeWei = await this.contract.methods.AUCTION_FEE().call();
      else if (this.contract.methods.auctionFee) feeWei = await this.contract.methods.auctionFee().call();
      else feeWei = this.web3.utils.toWei("0.02", "ether");

      await this.contract.methods
        .createAuction(newTitle.trim(), String(startPriceWei), String(durationBlocks))
        .send({ from: currentAccount, value: String(feeWei) });

      alert("Auction created");
      await this.refreshAll();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Create auction failed");
    }
  };

  getMyBidWei = async (auctionId) => {
    // Προσπαθούμε να βρούμε πόσα έχει ήδη δώσει ο χρήστης σε αυτή τη δημοπρασία (για delta)
    try {
      const { currentAccount } = this.state;
      if (!currentAccount) return "0";

      if (this.contract.methods.bids) {
        return await this.contract.methods.bids(auctionId, currentAccount).call();
      }
      if (this.contract.methods.userBids) {
        return await this.contract.methods.userBids(auctionId, currentAccount).call();
      }
      return "0";
    } catch (e) {
      return "0";
    }
  };

  placeBid = async (auctionId, currentHighestWei) => {
    try {
      const { currentAccount } = this.state;
      if (!currentAccount) return;

      const raw = (this.state.bidInputs[auctionId] || "").trim();
      if (!raw) {
        alert("Γράψε ποσό προσφοράς σε ETH.");
        return;
      }

      const newTotalWei = this.web3.utils.toWei(String(raw), "ether");

      // must be > current highest
      if (this.web3.utils.toBN) {
        // web3 v1
        const a = this.web3.utils.toBN(String(newTotalWei));
        const b = this.web3.utils.toBN(String(currentHighestWei));
        if (a.lte(b)) {
          alert("Η προσφορά πρέπει να είναι μεγαλύτερη από την τρέχουσα.");
          return;
        }
      } else {
        // fallback string compare by length (ok for wei strings)
        const a = String(newTotalWei);
        const b = String(currentHighestWei);
        if (a.length < b.length || (a.length === b.length && a <= b)) {
          alert("Η προσφορά πρέπει να είναι μεγαλύτερη από την τρέχουσα.");
          return;
        }
      }

      // delta payment: newTotal - myPrev
      const prevWei = await this.getMyBidWei(auctionId);
      let deltaWei = "0";

      if (this.web3.utils.toBN) {
        const A = this.web3.utils.toBN(String(newTotalWei));
        const P = this.web3.utils.toBN(String(prevWei));
        if (A.lte(P)) {
          alert("Έχεις ήδη δώσει ίσο/μεγαλύτερο ποσό σε αυτή τη δημοπρασία.");
          return;
        }
        deltaWei = A.sub(P).toString();
      } else {
        // αν δεν έχουμε BN, στέλνουμε το full amount (σε κάποια contracts θα αποτύχει).
        // Στα περισσότερα που ακολουθούν την εργασία υπάρχει bids() και δεν θα φτάσουμε εδώ.
        deltaWei = String(newTotalWei);
      }

      await this.contract.methods
        .placeBid(String(auctionId), String(newTotalWei))
        .send({ from: currentAccount, value: String(deltaWei) });

      this.setBidInput(auctionId, "");
      await this.refreshAll();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Bid failed");
    }
  };

  cancelAuction = async (auctionId) => {
    try {
      const { currentAccount } = this.state;
      if (!currentAccount) return;

      await this.contract.methods.cancelAuction(String(auctionId)).send({ from: currentAccount });
      await this.refreshAll();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Cancel failed");
    }
  };

  fulfillAuction = async (auctionId) => {
    try {
      const { currentAccount } = this.state;
      if (!currentAccount) return;

      await this.contract.methods.fulfillAuction(String(auctionId)).send({ from: currentAccount });
      await this.refreshAll();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Fulfill failed");
    }
  };

  claim = async () => {
    try {
      const { currentAccount } = this.state;
      if (!currentAccount) return;

      await this.contract.methods.claim().send({ from: currentAccount });
      await this.refreshAll();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Claim failed");
    }
  };

  withdraw = async () => {
    try {
      const { currentAccount } = this.state;
      if (!currentAccount) return;

      await this.contract.methods.withdraw().send({ from: currentAccount });
      await this.refreshAll();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Withdraw failed");
    }
  };

  changeOwner = async () => {
    try {
      const { currentAccount, adminNewOwner } = this.state;
      if (!currentAccount) return;

      if (!adminNewOwner || !adminNewOwner.trim()) {
        alert("Βάλε address νέου owner.");
        return;
      }

      await this.contract.methods.changeOwner(adminNewOwner.trim()).send({ from: currentAccount });
      await this.refreshAll();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Change owner failed");
    }
  };

  banSeller = async () => {
    try {
      const { currentAccount, adminBanSeller } = this.state;
      if (!currentAccount) return;

      if (!adminBanSeller || !adminBanSeller.trim()) {
        alert("Βάλε address seller για ban.");
        return;
      }

      await this.contract.methods.banSeller(adminBanSeller.trim()).send({ from: currentAccount });
      await this.refreshAll();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Ban seller failed");
    }
  };

  destroy = async () => {
    try {
      const { currentAccount } = this.state;
      if (!currentAccount) return;

      await this.contract.methods.destroy().send({ from: currentAccount });
      await this.refreshAll();
    } catch (e) {
      console.error(e);
      alert(e?.message || "Destroy failed");
    }
  };

  blocksLeft = (endBlockStr) => {
    const cb = parseInt(String(this.state.currentBlock || "0"), 10);
    const eb = parseInt(String(endBlockStr || "0"), 10);
    if (!cb || !eb) return "";
    const left = eb - cb;
    return left > 0 ? String(left) : "0";
  };

  renderTop() {
    const {
      currentAccount,
      owner,
      contractBalanceEth,
      collectedFeesEth,
      auctionFeeEth,
      currentBlock,
      status,
    } = this.state;

    return (
      <div style={{ border: "1px solid #ccc", padding: 12, marginBottom: 16 }}>
        <div>
          <b>Current Account:</b> {currentAccount || "-"}
        </div>
        <div>
          <b>Owner:</b> {owner || "-"}
        </div>
        <div>
          <b>Contract Balance (ETH):</b> {contractBalanceEth || "0"}
        </div>
        <div>
          <b>Collected Fees (ETH):</b> {collectedFeesEth || "0"}
        </div>
        <div>
          <b>Auction Fee (ETH):</b> {auctionFeeEth || "0"}
        </div>
        <div>
          <b>Current Block:</b> {currentBlock || "-"}
        </div>
        <div style={{ marginTop: 8 }}>
          <b>Status:</b> {status}
        </div>

        <div style={{ marginTop: 10 }}>
          <button onClick={this.refreshAll}>Refresh</button>
        </div>
      </div>
    );
  }

  renderNewAuction() {
    const { currentAccount, owner, destroyed, auctionFeeEth, newTitle, newStartPriceEth, newDurationBlocks } =
      this.state;

    const isOwner = owner && currentAccount && owner.toLowerCase() === currentAccount.toLowerCase();
    const createDisabled = !currentAccount || isOwner || destroyed;

    return (
      <div style={{ border: "1px solid #ccc", padding: 12, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>New auction</h3>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div>Title</div>
            <input
              value={newTitle}
              onChange={this.onChange("newTitle")}
              style={{ width: 300 }}
              placeholder="Unique title"
            />
          </div>

          <div>
            <div>Initial price (ETH)</div>
            <input
              value={newStartPriceEth}
              onChange={this.onChange("newStartPriceEth")}
              style={{ width: 160 }}
              placeholder="0.001"
            />
          </div>

          <div>
            <div>Duration in blocks</div>
            <input
              value={newDurationBlocks}
              onChange={this.onChange("newDurationBlocks")}
              style={{ width: 160 }}
              placeholder="500"
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={this.createAuction} disabled={createDisabled}>
              Create
            </button>
            <div>Fee required: {auctionFeeEth} ETH</div>
          </div>
        </div>

        <div style={{ marginTop: 8, color: "#444" }}>
          {isOwner ? "Ο owner δεν επιτρέπεται να δημιουργεί δημοπρασίες." : ""}
          {destroyed ? " Το contract είναι Destroyed." : ""}
        </div>
      </div>
    );
  }

  renderLiveAuctions() {
    const { activeAuctions, currentAccount, owner } = this.state;
    const isOwner =
      owner && currentAccount && owner.toLowerCase() === currentAccount.toLowerCase();

    return (
      <div style={{ border: "1px solid #ccc", padding: 12, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Live auctions</h3>

        {activeAuctions.length === 0 ? (
          <div>No active auctions.</div>
        ) : (
          activeAuctions.map((a) => {
            const startPriceEth = this.web3.utils.fromWei(String(a.startPriceWei), "ether");
            const highestEth = this.web3.utils.fromWei(String(a.highestBidWei), "ether");
            const currentPriceWei = a.highestBidWei && a.highestBidWei !== "0" ? a.highestBidWei : a.startPriceWei;
            const currentPriceEth = this.web3.utils.fromWei(String(currentPriceWei), "ether");

            const left = this.blocksLeft(a.endBlock);
            const ended = left === "0";
            const hasBid = a.highestBidWei && a.highestBidWei !== "0";

            const isSeller =
              a.seller && currentAccount && a.seller.toLowerCase() === currentAccount.toLowerCase();

            const canCancel = !!currentAccount && (isSeller || isOwner);
            const canFulfill = !!currentAccount && (isSeller || isOwner) && ended && hasBid;

            const youAreHighest =
              a.highestBidder &&
              currentAccount &&
              a.highestBidder.toLowerCase() === currentAccount.toLowerCase();

            const bidValue = this.state.bidInputs[a.id] || "";

            return (
              <div key={a.id} style={{ border: "1px solid #ddd", padding: 10, marginBottom: 10 }}>
                <div><b>Seller</b> {a.seller}</div>
                <div><b>Title</b> {a.title}</div>
                <div><b>Current Price</b> {currentPriceEth} ETH</div>
                <div><b>Initial Price</b> {startPriceEth} ETH</div>
                <div><b>Highest Bid</b> {highestEth} ETH</div>
                <div><b>Highest Bidder</b> {a.highestBidder}</div>
                <div><b>Blocks left</b> {left}</div>
                <div><b>You made it</b> {youAreHighest ? "Yes" : "No"}</div>

                <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    value={bidValue}
                    onChange={(e) => this.setBidInput(a.id, e.target.value)}
                    placeholder="Bid amount (ETH)"
                    style={{ width: 180 }}
                    disabled={!currentAccount || ended}
                  />
                  <button
                    onClick={() => this.placeBid(a.id, currentPriceWei)}
                    disabled={!currentAccount || ended}
                  >
                    Bid
                  </button>

                  <button onClick={() => this.cancelAuction(a.id)} disabled={!canCancel}>
                    Cancel
                  </button>

                  <button onClick={() => this.fulfillAuction(a.id)} disabled={!canFulfill}>
                    Fulfill
                  </button>
                </div>

                <div style={{ marginTop: 8, color: "#444" }}>
                  Η επίσημη λήξη γίνεται με Fulfill από πωλητή ή ιδιοκτήτη, αφού τελειώσει ο χρόνος και υπάρχει προσφορά.
                </div>
              </div>
            );
          })
        )}

        <div style={{ color: "#444", marginTop: 8 }}>
          Owner can cancel/fulfill any auction. Everyone can bid. Bids after time end should be rejected by the contract.
        </div>
      </div>
    );
  }

  renderFulfilled() {
    const { completedAuctions } = this.state;

    return (
      <div style={{ border: "1px solid #ccc", padding: 12, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Fulfilled auctions</h3>
        {completedAuctions.length === 0 ? (
          <div>No fulfilled auctions.</div>
        ) : (
          completedAuctions.map((a) => {
            const priceWei = a.highestBidWei && a.highestBidWei !== "0" ? a.highestBidWei : a.startPriceWei;
            const priceEth = this.web3.utils.fromWei(String(priceWei), "ether");
            return (
              <div key={a.id} style={{ border: "1px solid #ddd", padding: 10, marginBottom: 10 }}>
                <div><b>Auction ID</b> {a.id}</div>
                <div><b>Title</b> {a.title}</div>
                <div><b>Seller</b> {a.seller}</div>
                <div><b>Final Price</b> {priceEth} ETH</div>
              </div>
            );
          })
        )}
      </div>
    );
  }

  renderCanceled() {
    const { cancelledAuctions, claimEnabled, claimAmountEth } = this.state;

    return (
      <div style={{ border: "1px solid #ccc", padding: 12, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Canceled auctions</h3>

        <div style={{ marginBottom: 10 }}>
          <button onClick={this.claim} disabled={!claimEnabled}>
            Claim
          </button>
          <span style={{ marginLeft: 10, color: "#444" }}>
            Ενεργοποιείται όταν το συμβόλαιο χρωστάει στον συνδεδεμένο χρήστη (pendingReturns).
            {claimEnabled ? ` Ποσό: ${claimAmountEth} ETH` : ""}
          </span>
        </div>

        {cancelledAuctions.length === 0 ? (
          <div>No canceled auctions.</div>
        ) : (
          cancelledAuctions.map((a) => (
            <div key={a.id} style={{ border: "1px solid #ddd", padding: 10, marginBottom: 10 }}>
              <div><b>Auction ID</b> {a.id}</div>
              <div><b>Title</b> {a.title}</div>
              <div><b>Seller</b> {a.seller}</div>
            </div>
          ))
        )}
      </div>
    );
  }

  renderControlPanel() {
    const { currentAccount, owner, destroyed, adminNewOwner, adminBanSeller } = this.state;
    const isOwner =
      owner && currentAccount && owner.toLowerCase() === currentAccount.toLowerCase();

    return (
      <div style={{ border: "1px solid #ccc", padding: 12, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Control Panel</h3>

        <div style={{ display: "grid", gridTemplateColumns: "140px 1fr auto", gap: 10, alignItems: "center" }}>
          <button onClick={this.withdraw} disabled={!isOwner || destroyed}>
            Withdraw
          </button>
          <div></div>
          <div></div>

          <div style={{ gridColumn: "1 / 4", height: 1, background: "#eee" }} />

          <div>New owner's address</div>
          <input value={adminNewOwner} onChange={this.onChange("adminNewOwner")} placeholder="0x..." />
          <button onClick={this.changeOwner} disabled={!isOwner || destroyed}>
            Change owner
          </button>

          <div>Seller address</div>
          <input value={adminBanSeller} onChange={this.onChange("adminBanSeller")} placeholder="0x..." />
          <button onClick={this.banSeller} disabled={!isOwner || destroyed}>
            Ban seller
          </button>

          <div></div>
          <div></div>
          <button onClick={this.destroy} disabled={!isOwner || destroyed}>
            Destroy
          </button>
        </div>

        <div style={{ marginTop: 10, color: "#444" }}>
          Τα κουμπιά λειτουργούν μόνο όταν ο συνδεδεμένος χρήστης είναι ο owner.
          Μετά το Destroy δεν επιτρέπονται νέες δημοπρασίες και παύουν να λειτουργούν οι λειτουργίες του πίνακα,
          αλλά το Claim πρέπει να παραμείνει διαθέσιμο.
        </div>

        <div style={{ marginTop: 10, color: "#444" }}>
          Τα δεδομένα ενημερώνονται μέσω events (contract events και new block headers) και αλλαγών του MetaMask.
        </div>
      </div>
    );
  }

  render() {
    return (
      <div style={{ padding: 20, fontFamily: "Arial" }}>
        <h2>Auction Platform</h2>

        {this.renderTop()}
        {this.renderNewAuction()}
        {this.renderLiveAuctions()}
        {this.renderFulfilled()}
        {this.renderCanceled()}
        {this.renderControlPanel()}
      </div>
    );
  }
}

export default App;
