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
    var companyKey = form.getAttribute("data-company-key");
    var deadline = form.getAttribute("data-deadline");
    return ethereum.request({ method: "eth_requestAccounts" }).then(function (accounts) {
      var account = accounts && accounts[0];
      if (typeof account !== "string" || account === "") {
        say("The wallet did not return an account.");
        return;
      }
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
    }).catch(function () {
      say("The wallet did not sign.");
    });
  });
}());
