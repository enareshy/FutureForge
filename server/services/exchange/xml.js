// Safe XML parsing and serialization (§13).
//
// A small, dependency-free, strict XML reader. It intentionally refuses the
// features that make XML dangerous rather than trying to sandbox them:
//   * DOCTYPE / ENTITY declarations are rejected outright (no XXE, no billion
//     laughs / entity-expansion bombs, no external entity resolution).
//   * Depth, node and byte limits bound memory.
// Only elements, attributes, text and CDATA are supported. Namespaces are kept
// as qualified names so mapping stays explicit.
import { parseFailed, serializeFailed } from "./errors.js";
import { MAX_XML_DEPTH, MAX_XML_NODES, MAX_PAYLOAD_BYTES } from "./constants.js";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    return named[body] !== undefined ? named[body] : match;
  });
}

export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function assertSafeXml(source, maxBytes = MAX_PAYLOAD_BYTES) {
  const text = typeof source === "string" ? source : String(source ?? "");
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw parseFailed(`XML payload exceeds the ${maxBytes} byte limit`);
  }
  const lower = text.toLowerCase();
  if (lower.includes("<!doctype")) {
    throw parseFailed("XML DOCTYPE declarations are not allowed (XXE protection)");
  }
  if (lower.includes("<!entity")) {
    throw parseFailed("XML ENTITY declarations are not allowed (entity expansion protection)");
  }
  // Scan for dangerous external-resource hints that cannot appear in safe XML.
  if (/\bsystem\s+["']/i.test(text) && lower.includes("<!doctype")) {
    throw parseFailed("XML external entities are not allowed");
  }
  return text;
}

// Parses XML into a tree of { name, attributes, children, text }. The returned
// root wraps the document element under a synthetic `#document` node.
export function parseXml(source, { maxDepth = MAX_XML_DEPTH, maxNodes = MAX_XML_NODES, maxBytes = MAX_PAYLOAD_BYTES } = {}) {
  const text = assertSafeXml(source, maxBytes);
  const root = { type: "document", name: "#document", attributes: {}, children: [], text: "" };
  const stack = [root];
  let index = 0;
  let nodes = 0;
  const length = text.length;

  const top = () => stack[stack.length - 1];
  const pushText = (raw) => {
    const decoded = decodeEntities(raw);
    if (decoded.trim() === "" && top().children.length > 0) {
      top().text += decoded;
      return;
    }
    top().text += decoded;
  };

  while (index < length) {
    const lt = text.indexOf("<", index);
    if (lt === -1) {
      pushText(text.slice(index));
      break;
    }
    if (lt > index) pushText(text.slice(index, lt));
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end === -1) throw parseFailed("Unterminated XML comment");
      index = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      if (end === -1) throw parseFailed("Unterminated CDATA section");
      top().text += text.slice(lt + 9, end);
      index = end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      if (end === -1) throw parseFailed("Unterminated XML processing instruction");
      index = end + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      throw parseFailed("Unsupported XML declaration");
    }
    if (text.startsWith("</", lt)) {
      const end = text.indexOf(">", lt + 2);
      if (end === -1) throw parseFailed("Unterminated XML close tag");
      const name = text.slice(lt + 2, end).trim();
      if (!NAME_RE.test(name)) throw parseFailed(`Invalid XML close tag: ${name}`);
      if (stack.length <= 1) throw parseFailed(`Unexpected XML close tag: ${name}`);
      const node = stack.pop();
      if (node.name !== name) throw parseFailed(`Mismatched XML close tag: expected </${node.name}> but found </${name}>`);
      index = end + 1;
      continue;
    }
    // Open tag: read until matching '>' while respecting quoted attributes.
    const open = readOpenTag(text, lt);
    const { name, attributes, selfClosing } = open;
    nodes += 1;
    if (nodes > maxNodes) throw parseFailed(`XML document exceeds the ${maxNodes} element limit`);
    if (stack.length > maxDepth) throw parseFailed(`XML document exceeds the ${maxDepth} depth limit`);
    const node = { type: "element", name, attributes, children: [], text: "" };
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    index = open.end;
  }

  if (stack.length !== 1) throw parseFailed(`Unclosed XML element: <${top().name}>`);
  return root;
}

function readOpenTag(text, start) {
  let index = start + 1;
  const nameMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(text.slice(index));
  if (!nameMatch) throw parseFailed("Invalid XML element name");
  const name = nameMatch[0];
  index += name.length;
  const attributes = {};
  let selfClosing = false;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] === "/" && text[index + 1] === ">") {
      selfClosing = true;
      index += 2;
      break;
    }
    if (text[index] === ">") {
      index += 1;
      break;
    }
    const attrMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(text.slice(index));
    if (!attrMatch) throw parseFailed(`Invalid XML attribute near: ${text.slice(index, index + 20)}`);
    const attrName = attrMatch[0];
    index += attrName.length;
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] !== "=") throw parseFailed(`XML attribute ${attrName} is missing a value`);
    index += 1;
    while (index < text.length && /\s/.test(text[index])) index += 1;
    const quote = text[index];
    if (quote !== '"' && quote !== "'") throw parseFailed(`XML attribute ${attrName} value must be quoted`);
    const endQuote = text.indexOf(quote, index + 1);
    if (endQuote === -1) throw parseFailed(`Unterminated XML attribute ${attrName}`);
    attributes[attrName] = decodeEntities(text.slice(index + 1, endQuote));
    index = endQuote + 1;
  }
  return { name, attributes, selfClosing, end: index };
}

// Serializes a tree back to XML. Attribute order follows insertion order.
export function serializeXml(node, { declaration = true, indent = 0 } = {}) {
  try {
    const body = serializeNode(node, indent);
    return declaration ? `<?xml version="1.0" encoding="UTF-8"?>\n${body}` : body;
  } catch (error) {
    throw serializeFailed(`Failed to serialize XML: ${error.message}`);
  }
}

function serializeNode(node, depth) {
  if (node.type === "document") {
    return (node.children || []).map((child) => serializeNode(child, depth)).join("\n");
  }
  const pad = "  ".repeat(depth);
  const attributes = Object.entries(node.attributes || {})
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join("");
  const children = node.children || [];
  const text = node.text || "";
  if (children.length === 0 && text === "") return `${pad}<${node.name}${attributes}/>`;
  if (children.length === 0) return `${pad}<${node.name}${attributes}>${escapeXml(text)}</${node.name}>`;
  const inner = children.map((child) => serializeNode(child, depth + 1)).join("\n");
  const close = text.trim() ? `${pad}  ${escapeXml(text.trim())}\n${pad}</${node.name}>` : `${pad}</${node.name}>`;
  return `${pad}<${node.name}${attributes}>\n${inner}\n${close}`;
}

// Converts an element tree to a plain object: attributes become `@name`, text
// becomes `$text`, and repeated child elements become arrays.
export function xmlToObject(node) {
  if (node.type === "document") {
    if (node.children.length === 1) return xmlToObject(node.children[0]);
    return { children: node.children.map(xmlToObject) };
  }
  const output = {};
  for (const [key, value] of Object.entries(node.attributes || {})) output[`@${key}`] = value;
  const children = node.children || [];
  for (const child of children) {
    const value = xmlToObject(child);
    if (output[child.name] === undefined) output[child.name] = value;
    else if (Array.isArray(output[child.name])) output[child.name].push(value);
    else output[child.name] = [output[child.name], value];
  }
  if (children.length === 0) {
    const text = (node.text || "").trim();
    if (Object.keys(output).length === 0) return text;
    if (text) output.$text = text;
    return output;
  }
  const text = (node.text || "").trim();
  if (text) output.$text = text;
  return output;
}

export function objectToXml(name, value) {
  if (Array.isArray(value)) {
    return value.map((entry) => objectToXml(name, entry));
  }
  if (value === null || value === undefined) return { type: "element", name, attributes: {}, children: [], text: "" };
  if (typeof value !== "object") {
    return { type: "element", name, attributes: {}, children: [], text: String(value) };
  }
  const attributes = {};
  const children = [];
  let text = "";
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (key === "$text") text = String(entry);
    else if (key.startsWith("@")) attributes[key.slice(1)] = String(entry);
    else if (Array.isArray(entry)) entry.forEach((item) => children.push(...[].concat(objectToXml(key, item))));
    else children.push(objectToXml(key, entry));
  }
  return { type: "element", name, attributes, children, text };
}

export const XML_LIMITS = Object.freeze({ maxDepth: MAX_XML_DEPTH, maxNodes: MAX_XML_NODES, maxBytes: MAX_PAYLOAD_BYTES });
