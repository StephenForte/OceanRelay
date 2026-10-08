"use strict";
(function () {
  var form = document.getElementById("wallet-bind");
  if (!form) return;
  var button = document.getElementById("wallet-sign");
  if (!button) return;

  function say(text) {
    var note = document.getElementById("wallet-note");
    if (note) note.textContent = text;
  }

  function hexChainId(value) {
    var n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n <= 0 || n > 9007199254740991) return "";
    return "0x" + n.toString(16);
  }

  function errorCode(err) {
    return err && typeof err.code === "number" ? err.code : null;
  }

  button.addEventListener("click", function (event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    var ethereum = window.ethereum;
    if (!ethereum || typeof ethereum.request !== "function") {
      say("A browser wallet is required.");
      return;
    }
    var domain;
    try {
      domain = JSON.parse(form.getAttribute("data-domain"));
    } catch (err) {
      say("Binding is unavailable.");
      return;
    }
    var chainHex = hexChainId(domain && domain.chainId);
    if (!chainHex) {
      say("Binding is unavailable.");
      return;
    }
    var companyKey = form.getAttribute("data-company-key");
    var deadline = form.getAttribute("data-deadline");

    function sign(account) {
      var typedData = {
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          Binding: [
            { name: "companyKey", type: "bytes32" },
            { name: "wallet", type: "address" },
            { name: "deadline", type: "uint64" },
          ],
        },
        primaryType: "Binding",
        domain: {
          name: domain.name,
          version: domain.version,
          chainId: domain.chainId,
          verifyingContract: domain.verifyingContract,
        },
        message: {
          companyKey: companyKey,
          wallet: account,
          deadline: deadline,
        },
      };
      return ethereum.request({
        method: "eth_signTypedData_v4",
        params: [account, JSON.stringify(typedData)],
      }).then(function (signature) {
        var walletInput = form.querySelector("input[name=wallet]");
        var signatureInput = form.querySelector("input[name=signature]");
        if (walletInput) walletInput.value = account;
        if (signatureInput) signatureInput.value = signature;
        form.submit();
      });
    }

    function addThenSign(account) {
      var chain;
      try {
        chain = JSON.parse(form.getAttribute("data-chain"));
      } catch (err) {
        say("Binding is unavailable.");
        return;
      }
      if (!chain || typeof chain !== "object") {
        say("Binding is unavailable.");
        return;
      }
      return ethereum.request({
        method: "wallet_addEthereumChain",
        params: [chain],
      }).then(function () {
        return sign(account);
      }, function () {
        say("The wallet did not switch to this chain.");
      });
    }

    return ethereum.request({ method: "eth_requestAccounts" }).then(function (accounts) {
      var account = accounts && accounts[0];
      if (typeof account !== "string" || account === "") {
        say("The wallet did not return an account.");
        return;
      }
      return ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainHex }],
      }).then(function () {
        return sign(account);
      }, function (err) {
        if (errorCode(err) === 4902) return addThenSign(account);
        say("The wallet did not switch to this chain.");
      });
    }).catch(function () {
      say("The wallet did not sign.");
    });
  });
}());
