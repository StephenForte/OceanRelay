"use strict";

const abi = require("../../contracts/abi/OceanRelayLedger.json");
const { keccak } = require("./keccak");
const {
  addressToWord,
  bigToBytes,
  bytesToBig,
  bytesToHex,
  concat,
  hexToBytes,
  utf8,
  wordToAddress,
} = require("./hex");

const RECORD_FUNCTIONS = Object.freeze([
  "bindWallet",
  "publishOffer",
  "publishVersion",
  "setOfferState",
  "markExpired",
  "recordRequest",
  "recordAcceptance",
  "recordStatus",
  "recordCancellation",
]);

const functions = new Map();
const errors = new Map();

for (const item of abi) {
  if (item.type === "function") {
    const signature = item.name + "(" + item.inputs.map((input) => canonical(input)).join(",") + ")";
    functions.set(item.name, {
      signature,
      selector: bytesToHex(keccak(utf8(signature)).subarray(0, 4)),
      inputs: item.inputs,
      outputs: item.outputs || [],
    });
  } else if (item.type === "error") {
    const signature = item.name + "(" + item.inputs.map((input) => canonical(input)).join(",") + ")";
    const selector = bytesToHex(keccak(utf8(signature)).subarray(0, 4));
    errors.set(selector.toLowerCase(), { name: item.name, inputs: item.inputs, signature });
  }
}

function canonical(input) {
  if (input.type === "tuple") {
    return "(" + input.components.map((part) => canonical(part)).join(",") + ")";
  }
  if (input.type === "tuple[]") {
    return "(" + input.components.map((part) => canonical(part)).join(",") + ")[]";
  }
  return input.type;
}

function isDynamic(type) {
  if (type === "bytes" || type === "string") return true;
  if (type.endsWith("[]")) return true;
  if (type.startsWith("(")) return tupleTypes(type).some(isDynamic);
  return false;
}

function tupleTypes(type) {
  const body = type.slice(1, type.endsWith("[]") ? -3 : -1);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (body.length) parts.push(body.slice(start));
  return parts;
}

function word(value) {
  return bigToBytes(value, 32);
}

function padRight(bytes) {
  const size = Math.ceil(bytes.length / 32) * 32;
  const out = new Uint8Array(size);
  out.set(bytes, 0);
  return out;
}

function encodeParameters(types, values) {
  if (types.length !== values.length) throw new Error("bad_args");
  const head = new Array(types.length);
  const tails = [];
  let tailBytes = 0;
  const headBytes = types.length * 32;
  for (let i = 0; i < types.length; i += 1) {
    if (isDynamic(types[i])) {
      head[i] = word(headBytes + tailBytes);
      const encoded = encodeDynamic(types[i], values[i]);
      tails.push(encoded);
      tailBytes += encoded.length;
    } else {
      head[i] = encodeStatic(types[i], values[i]);
    }
  }
  return concat([...head, ...tails]);
}

function encodeStatic(type, value) {
  if (type === "address") return addressToWord(value);
  if (type === "bool") return word(value ? 1 : 0);
  const bytesSize = /^bytes(\d+)$/.exec(type);
  if (bytesSize) {
    const size = Number(bytesSize[1]);
    const bytes = hexToBytes(value);
    if (bytes.length !== size) throw new Error("bad_args");
    return padRight(bytes);
  }
  if (type === "bytes32") {
    const bytes = hexToBytes(value);
    if (bytes.length !== 32) throw new Error("bad_args");
    return bytes;
  }
  const uint = /^uint(\d+)$/.exec(type);
  if (uint) {
    const bits = Number(uint[1]);
    const n = BigInt(value);
    if (n < 0n || n >= 1n << BigInt(bits)) throw new Error("bad_args");
    return word(n);
  }
  if (type.startsWith("(") && type.endsWith(")")) {
    return encodeParameters(tupleTypes(type), value);
  }
  throw new Error("bad_type");
}

function encodeDynamic(type, value) {
  if (type === "bytes") return encodeBytes(value instanceof Uint8Array ? value : hexToBytes(value));
  if (type === "string") return encodeBytes(utf8(String(value)));
  if (type.endsWith("[]")) {
    const element = type.slice(0, -2);
    if (!Array.isArray(value)) throw new Error("bad_args");
    const body = encodeParameters(value.map(() => element), value);
    return concat([word(value.length), body]);
  }
  throw new Error("bad_type");
}

function encodeBytes(bytes) {
  return concat([word(BigInt(bytes.length)), bytes.length ? padRight(bytes) : new Uint8Array()]);
}

function encodeCall(name, args) {
  const fn = functions.get(name);
  if (!fn) throw new Error("bad_function");
  const values = args || [];
  const encoded = encodeParameters(fn.inputs.map((input) => canonical(input)), values);
  return fn.selector + Buffer.from(encoded).toString("hex");
}

function decodeResult(name, dataHex) {
  const fn = functions.get(name);
  if (!fn) throw new Error("bad_function");
  const data = hexToBytes(dataHex || "0x");
  if (fn.outputs.length === 0) return null;
  const values = decodeParameters(fn.outputs.map((output) => canonical(output)), data, 0);
  return values.length === 1 ? values[0] : values;
}

function decodeRevert(dataHex) {
  let data;
  try {
    data = hexToBytes(dataHex || "0x");
  } catch {
    return { name: "Revert", args: [] };
  }
  if (data.length < 4) return { name: "Revert", args: [] };
  const selector = bytesToHex(data.subarray(0, 4)).toLowerCase();
  const known = errors.get(selector);
  if (!known) return { name: "Revert", args: [bytesToHex(data)] };
  try {
    const args = decodeParameters(known.inputs.map((input) => canonical(input)), data.subarray(4), 0);
    return { name: known.name, args };
  } catch {
    return { name: known.name, args: [] };
  }
}

function decodeParameters(types, data, offset) {
  const values = [];
  for (let i = 0; i < types.length; i += 1) {
    if (isDynamic(types[i])) {
      const pointer = Number(bytesToBig(readWord(data, offset + i * 32)));
      values.push(decodeDynamic(types[i], data, offset + pointer));
    } else {
      values.push(decodeStatic(types[i], data, offset + i * 32));
    }
  }
  return values;
}

function decodeStatic(type, data, offset) {
  const wordBytes = readWord(data, offset);
  if (type === "address") return wordToAddress(wordBytes);
  if (type === "bool") {
    const n = bytesToBig(wordBytes);
    if (n !== 0n && n !== 1n) throw new Error("bad_abi");
    return n === 1n;
  }
  const bytesSize = /^bytes(\d+)$/.exec(type);
  if (bytesSize) return bytesToHex(wordBytes.subarray(0, Number(bytesSize[1])));
  const uint = /^uint(\d+)$/.exec(type);
  if (uint) return numberValue(bytesToBig(wordBytes));
  if (type.startsWith("(") && type.endsWith(")")) {
    return decodeParameters(tupleTypes(type), data, offset);
  }
  throw new Error("bad_type");
}

function decodeDynamic(type, data, offset) {
  if (type === "bytes" || type === "string") {
    const length = Number(bytesToBig(readWord(data, offset)));
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("bad_abi");
    const start = offset + 32;
    if (start + length > data.length) throw new Error("bad_abi");
    const bytes = data.subarray(start, start + length);
    if (type === "bytes") return bytesToHex(bytes);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (type.endsWith("[]")) {
    const element = type.slice(0, -2);
    const length = Number(bytesToBig(readWord(data, offset)));
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("bad_abi");
    return decodeParameters(Array.from({ length }, () => element), data, offset + 32);
  }
  throw new Error("bad_type");
}

function readWord(data, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 32 > data.length) {
    throw new Error("bad_abi");
  }
  return data.subarray(offset, offset + 32);
}

function numberValue(value) {
  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return value.toString();
}

function selectorOf(name) {
  const fn = functions.get(name);
  if (!fn) throw new Error("bad_function");
  return fn.selector;
}

module.exports = {
  RECORD_FUNCTIONS,
  encodeCall,
  decodeResult,
  decodeRevert,
  selectorOf,
};
