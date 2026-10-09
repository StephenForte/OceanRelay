"use strict";
(function () {
  var bindForm = document.getElementById("wallet-bind");
  var form = bindForm || document.getElementById("chain-sign");
  if (!form) return;
  var binding = Boolean(bindForm);
  var button = document.getElementById(binding ? "wallet-sign" : "chain-sign-button");
  if (!button) return;

  function say(text) {
    var note = document.getElementById(binding ? "wallet-note" : "chain-note");
    if (note) note.textContent = text;
  }

  function unavailable() {
    return binding ? "Binding is unavailable." : "Recording is unavailable.";
  }

  function hexChainId(value) {
    var n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n) || n <= 0 || n > 9007199254740991) return "";
    return "0x" + n.toString(16);
  }

  function errorCode(err) {
    return err && typeof err.code === "number" ? err.code : null;
  }

  function signBinding(account) {
    var companyKey = form.getAttribute("data-company-key");
    var deadline = form.getAttribute("data-deadline");
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
    return window.ethereum.request({
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

  function signTyped(account) {
    var typed;
    try {
      typed = JSON.parse(form.getAttribute("data-typed"));
    } catch (err) {
      say(unavailable());
      return;
    }
    return window.ethereum.request({
      method: "eth_signTypedData_v4",
      params: [account, JSON.stringify(typed)],
    }).then(function (signature) {
      var signatureInput = form.querySelector("input[name=signature]");
      if (signatureInput) signatureInput.value = signature;
      form.submit();
    });
  }

  var domain;
  try {
    domain = JSON.parse(form.getAttribute("data-domain"));
  } catch (err) {
    domain = null;
  }

  button.addEventListener("click", function (event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    var ethereum = window.ethereum;
    if (!ethereum || typeof ethereum.request !== "function") {
      say("A browser wallet is required.");
      return;
    }
    if (!domain) {
      say(unavailable());
      return;
    }
    var chainHex = hexChainId(domain && domain.chainId);
    if (!chainHex) {
      say(unavailable());
      return;
    }

    function sign(account) {
      if (binding) return signBinding(account);
      return signTyped(account);
    }

    function addThenSign(account) {
      var chain;
      try {
        chain = JSON.parse(form.getAttribute("data-chain"));
      } catch (err) {
        say(unavailable());
        return;
      }
      if (!chain || typeof chain !== "object") {
        say(unavailable());
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
