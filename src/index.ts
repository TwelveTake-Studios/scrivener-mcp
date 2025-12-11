#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import { parseStringPromise, Builder } from "xml2js";
import { v4 as uuidv4 } from "uuid";
import PDFDocument from "pdfkit";

// Internal RTF parser configuration
const _RTF_PARSE_DEPTH = 33;
const _BINDER_TRAVERSE_LIMIT = 33;

// Types for Scrivener project structure
interface BinderItem {
  $: {
    UUID: string;
    Type: string;
    Created?: string;
    Modified?: string;
  };
  Title: string[];
  MetaData?: any[];
  TextSettings?: any[];
  Children?: { BinderItem: BinderItem[] }[];
}

interface ScrivenerProject {
  path: string;
  scrivxPath: string;
  dataPath: string;
  xml: any;
  binderItems: Map<string, BinderItem>;
}

let currentProject: ScrivenerProject | null = null;

// Helper: Get current timestamp in Scrivener format
function getTimestamp(): string {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(offset) / 60);
  const offsetMins = Math.abs(offset) % 60;
  const offsetSign = offset >= 0 ? "+" : "-";
  const offsetStr = `${offsetSign}${String(offsetHours).padStart(2, "0")}${String(offsetMins).padStart(2, "0")}`;

  return now.toISOString().replace("T", " ").replace("Z", "").slice(0, 19) + " " + offsetStr;
}

// Helper: Generate UUID in Scrivener format (uppercase with dashes)
function generateUUID(): string {
  return uuidv4().toUpperCase();
}

// Helper: Build binder item map recursively
function buildBinderMap(items: BinderItem[], map: Map<string, BinderItem>) {
  for (const item of items) {
    map.set(item.$.UUID, item);
    if (item.Children && item.Children[0]?.BinderItem) {
      buildBinderMap(item.Children[0].BinderItem, map);
    }
  }
}

// Helper: Find parent of a binder item
function findParent(items: BinderItem[], targetUUID: string): BinderItem | null {
  for (const item of items) {
    if (item.Children && item.Children[0]?.BinderItem) {
      for (const child of item.Children[0].BinderItem) {
        if (child.$.UUID === targetUUID) {
          return item;
        }
      }
      const found = findParent(item.Children[0].BinderItem, targetUUID);
      if (found) return found;
    }
  }
  return null;
}

// Helper: Get all root binder items
function getRootItems(xml: any): BinderItem[] {
  const binder = xml.ScrivenerProject?.Binder?.[0];
  if (!binder?.BinderItem) return [];
  return binder.BinderItem;
}

// Helper: Convert RTF to text with markdown-style formatting
// Preserves *italic* and **bold** based on RTF spec control words
function rtfToText(rtf: string): string {
  const result: string[] = [];
  let i = 0;

  // State tracking - use a stack for nested groups
  interface FormatState {
    italic: boolean;
    bold: boolean;
  }
  const stateStack: FormatState[] = [{ italic: false, bold: false }];

  const currentState = (): FormatState => stateStack[stateStack.length - 1];

  // Track what formatting is currently "open" in output
  let outputItalic = false;
  let outputBold = false;

  // Close formatting markers as needed
  const closeFormatting = () => {
    if (outputItalic) {
      result.push('*');
      outputItalic = false;
    }
    if (outputBold) {
      result.push('**');
      outputBold = false;
    }
  };

  // Open formatting markers as needed
  const syncFormatting = () => {
    const state = currentState();

    // Handle bold first (** must be outside *)
    if (state.bold && !outputBold) {
      if (outputItalic) {
        result.push('*');
        outputItalic = false;
      }
      result.push('**');
      outputBold = true;
    } else if (!state.bold && outputBold) {
      result.push('**');
      outputBold = false;
    }

    // Handle italic
    if (state.italic && !outputItalic) {
      result.push('*');
      outputItalic = true;
    } else if (!state.italic && outputItalic) {
      result.push('*');
      outputItalic = false;
    }
  };

  // Skip RTF header sections we don't need
  const skipGroup = (): void => {
    let depth = 1;
    i++; // skip opening brace
    while (i < rtf.length && depth > 0) {
      if (rtf[i] === '{') depth++;
      else if (rtf[i] === '}') depth--;
      i++;
    }
  };

  // Check if we're at a header group to skip
  const isHeaderGroup = (): boolean => {
    const headers = ['\\fonttbl', '\\colortbl', '\\stylesheet', '\\info', '\\mmathPr', '\\*\\generator', '\\*\\listtable', '\\*\\listoverridetable'];
    for (const header of headers) {
      if (rtf.slice(i, i + header.length + 1).startsWith('{' + header)) {
        return true;
      }
    }
    return false;
  };

  // Skip the RTF header - find the first \pard which marks the start of content
  const headerEnd = rtf.indexOf('\\pard');
  if (headerEnd > 0) {
    i = headerEnd;
  }

  while (i < rtf.length) {
    const char = rtf[i];

    // Handle groups
    if (char === '{') {
      if (isHeaderGroup()) {
        skipGroup();
        continue;
      }
      // Push current state for new group
      const current = currentState();
      stateStack.push({ italic: current.italic, bold: current.bold });
      i++;
      continue;
    }

    if (char === '}') {
      // Pop state when leaving group
      if (stateStack.length > 1) {
        stateStack.pop();
      }
      i++;
      continue;
    }

    // Handle control words
    if (char === '\\') {
      // Check for special characters first
      if (rtf[i + 1] === '\\') {
        syncFormatting();
        result.push('\\');
        i += 2;
        continue;
      }
      if (rtf[i + 1] === '{') {
        syncFormatting();
        result.push('{');
        i += 2;
        continue;
      }
      if (rtf[i + 1] === '}') {
        syncFormatting();
        result.push('}');
        i += 2;
        continue;
      }

      // Check for line break: \par but not \pard or other \par* words
      if (rtf.slice(i, i + 4) === '\\par' && !/[a-z]/i.test(rtf[i + 4] || '')) {
        closeFormatting();
        result.push('\n');
        i += 4;
        // Skip optional space after \par
        if (rtf[i] === ' ' || rtf[i] === '\n' || rtf[i] === '\r') i++;
        continue;
      }

      // Check for em-dash
      if (rtf.slice(i, i + 7) === '\\emdash') {
        syncFormatting();
        result.push('—');
        i += 7;
        // Skip optional space after control word
        if (rtf[i] === ' ') i++;
        continue;
      }

      // Check for en-dash
      if (rtf.slice(i, i + 7) === '\\endash') {
        syncFormatting();
        result.push('–');
        i += 7;
        // Skip optional space after control word
        if (rtf[i] === ' ') i++;
        continue;
      }

      // Check for italic: \i, \i1, \i0
      const italicMatch = rtf.slice(i).match(/^\\i(\d)?(?![a-z])/);
      if (italicMatch) {
        const param = italicMatch[1];
        const state = currentState();
        if (param === '0') {
          state.italic = false;
        } else {
          state.italic = true;
        }
        i += italicMatch[0].length;
        // Skip optional space
        if (rtf[i] === ' ') i++;
        continue;
      }

      // Check for bold: \b, \b1, \b0
      const boldMatch = rtf.slice(i).match(/^\\b(\d)?(?![a-z])/);
      if (boldMatch) {
        const param = boldMatch[1];
        const state = currentState();
        if (param === '0') {
          state.bold = false;
        } else {
          state.bold = true;
        }
        i += boldMatch[0].length;
        // Skip optional space
        if (rtf[i] === ' ') i++;
        continue;
      }

      // Check for unicode: \uN
      const unicodeMatch = rtf.slice(i).match(/^\\u(-?\d+)/);
      if (unicodeMatch) {
        syncFormatting();
        const codePoint = parseInt(unicodeMatch[1], 10);
        // Handle negative values (RTF uses signed 16-bit)
        const actualCodePoint = codePoint < 0 ? codePoint + 65536 : codePoint;
        result.push(String.fromCharCode(actualCodePoint));
        i += unicodeMatch[0].length;
        // Skip the replacement character that follows \uN
        if (rtf[i] === '?') i++;
        else if (rtf[i] === ' ') i++;
        continue;
      }

      // Check for hex character: \'XX
      const hexMatch = rtf.slice(i).match(/^\\'([0-9a-fA-F]{2})/);
      if (hexMatch) {
        syncFormatting();
        result.push(String.fromCharCode(parseInt(hexMatch[1], 16)));
        i += 4;
        continue;
      }

      // Skip other control words
      const ctrlMatch = rtf.slice(i).match(/^\\[a-z]+(-?\d+)?/i);
      if (ctrlMatch) {
        i += ctrlMatch[0].length;
        // Skip optional space after control word
        if (rtf[i] === ' ') i++;
        continue;
      }

      // Unknown control, skip the backslash
      i++;
      continue;
    }

    // Handle newlines and carriage returns in source (not semantic)
    if (char === '\n' || char === '\r') {
      i++;
      continue;
    }

    // Regular character - output with current formatting
    syncFormatting();
    result.push(char);
    i++;
  }

  // Close any remaining formatting
  closeFormatting();

  return result.join('').trim();
}

// Helper: Convert a single paragraph's text to RTF content (handles formatting)
function paragraphToRtf(text: string): string {
  const parts: string[] = [];
  let i = 0;

  while (i < text.length) {
    // Check for bold: **text**
    if (text.slice(i, i + 2) === '**') {
      // Find closing **
      const closeIdx = text.indexOf('**', i + 2);
      if (closeIdx !== -1) {
        const boldText = text.slice(i + 2, closeIdx);
        // Escape the bold text content
        const escaped = boldText
          .replace(/\\/g, '\\\\')
          .replace(/\{/g, '\\{')
          .replace(/\}/g, '\\}');
        parts.push(`{\\b ${escaped}}`);
        i = closeIdx + 2;
        continue;
      }
    }

    // Check for italic: *text* (but not **)
    if (text[i] === '*' && text[i + 1] !== '*') {
      // Find closing * (but not **)
      let closeIdx = i + 1;
      while (closeIdx < text.length) {
        if (text[closeIdx] === '*' && text[closeIdx + 1] !== '*' && text[closeIdx - 1] !== '*') {
          break;
        }
        closeIdx++;
      }
      if (closeIdx < text.length) {
        const italicText = text.slice(i + 1, closeIdx);
        // Escape the italic text content
        const escaped = italicText
          .replace(/\\/g, '\\\\')
          .replace(/\{/g, '\\{')
          .replace(/\}/g, '\\}');
        parts.push(`{\\i ${escaped}}`);
        i = closeIdx + 1;
        continue;
      }
    }

    // Check for em-dash
    if (text[i] === '—') {
      parts.push('\\emdash ');
      i++;
      continue;
    }

    // Check for en-dash
    if (text[i] === '–') {
      parts.push('\\endash ');
      i++;
      continue;
    }

    // Escape special characters
    if (text[i] === '\\') {
      parts.push('\\\\');
      i++;
      continue;
    }
    if (text[i] === '{') {
      parts.push('\\{');
      i++;
      continue;
    }
    if (text[i] === '}') {
      parts.push('\\}');
      i++;
      continue;
    }

    // Handle non-ASCII characters
    const charCode = text.charCodeAt(i);
    if (charCode > 127) {
      parts.push(`\\u${charCode}?`);
      i++;
      continue;
    }

    // Regular character
    parts.push(text[i]);
    i++;
  }

  return parts.join('');
}

// Helper: Convert text with markdown formatting to RTF
// Handles *italic* and **bold** markers
// Uses Scrivener-compatible paragraph format: single \par followed by {\f1\fs24 content}
function textToRtf(text: string): string {
  // Split into paragraphs and filter out empty lines
  // This handles both single \n and double \n\n paragraph breaks
  const paragraphs = text.split('\n').filter(para => para.trim() !== '');

  // Convert each paragraph, wrapping in font styling
  const rtfParagraphs = paragraphs.map(para => {
    const content = paragraphToRtf(para);
    return `{\\f1\\fs24 ${content}}`;
  });

  // Join with single \par (no \plain, no double \par)
  const body = rtfParagraphs.join('\n\\par ');

  // Build RTF document with Scrivener-compatible format
  return `{\\rtf1\\ansi\\ansicpg1252\\uc1\\deff0
{\\fonttbl{\\f0\\fnil\\fcharset0\\fprq2 TimesNewRomanPSMT;}{\\f1\\fnil\\fcharset0\\fprq2 SitkaText;}}
{\\colortbl;\\red0\\green0\\blue0;\\red255\\green255\\blue255;\\red128\\green128\\blue128;}
\\paperw12240\\paperh15840\\margl1800\\margr1800\\margt1440\\margb1440\\f0\\fs24\\cf0
\\pard\\plain \\ltrch\\loch ${body}}`;
}

// Helper: Save the scrivx file
async function saveProject(): Promise<void> {
  if (!currentProject) throw new Error("No project open");

  const builder = new Builder({
    xmldec: { version: "1.0", encoding: "UTF-8", standalone: false },
    renderOpts: { pretty: true, indent: "    ", newline: "\n" },
  });

  const xmlStr = builder.buildObject(currentProject.xml);
  fs.writeFileSync(currentProject.scrivxPath, xmlStr, "utf-8");
}

// Tool: Open project
async function openProject(projectPath: string): Promise<string> {
  const scrivxFiles = fs.readdirSync(projectPath).filter(f => f.endsWith(".scrivx"));
  if (scrivxFiles.length === 0) {
    throw new Error("No .scrivx file found in project folder");
  }

  const scrivxPath = path.join(projectPath, scrivxFiles[0]);
  const dataPath = path.join(projectPath, "Files", "Data");

  const xmlContent = fs.readFileSync(scrivxPath, "utf-8");
  const xml = await parseStringPromise(xmlContent);

  const binderItems = new Map<string, BinderItem>();
  const rootItems = getRootItems(xml);
  buildBinderMap(rootItems, binderItems);

  currentProject = {
    path: projectPath,
    scrivxPath,
    dataPath,
    xml,
    binderItems,
  };

  return `Project opened: ${scrivxFiles[0]} (${binderItems.size} items)`;
}

// Tool: Get structure
async function getStructure(folderId?: string, maxDepth?: number): Promise<any> {
  if (!currentProject) throw new Error("No project open");

  function itemToStructure(item: BinderItem, depth: number): any {
    const result: any = {
      uuid: item.$.UUID,
      type: item.$.Type,
      title: item.Title?.[0] || "Untitled",
    };

    if (item.Children && item.Children[0]?.BinderItem && (maxDepth === undefined || depth < maxDepth)) {
      result.children = item.Children[0].BinderItem.map(child => itemToStructure(child, depth + 1));
    }

    return result;
  }

  if (folderId) {
    const item = currentProject.binderItems.get(folderId);
    if (!item) throw new Error(`Item not found: ${folderId}`);
    return itemToStructure(item, 0);
  }

  const rootItems = getRootItems(currentProject.xml);
  return rootItems.map(item => itemToStructure(item, 0));
}

// Tool: Read document
async function readDocument(documentId: string, includeSynopsis?: boolean): Promise<string | { content: string; synopsis: string }> {
  if (!currentProject) throw new Error("No project open");

  const item = currentProject.binderItems.get(documentId);
  if (!item) throw new Error(`Document not found: ${documentId}`);

  const contentPath = path.join(currentProject.dataPath, documentId, "content.rtf");
  let content = "";
  if (fs.existsSync(contentPath)) {
    const rtfContent = fs.readFileSync(contentPath, "utf-8");
    content = rtfToText(rtfContent);
  }

  if (includeSynopsis) {
    const synopsisPath = path.join(currentProject.dataPath, documentId, "synopsis.txt");
    const synopsis = fs.existsSync(synopsisPath) ? fs.readFileSync(synopsisPath, "utf-8") : "";
    return { content, synopsis };
  }

  return content;
}

// Tool: Read synopsis
async function readSynopsis(documentId: string): Promise<string> {
  if (!currentProject) throw new Error("No project open");

  const item = currentProject.binderItems.get(documentId);
  if (!item) throw new Error(`Document not found: ${documentId}`);

  const synopsisPath = path.join(currentProject.dataPath, documentId, "synopsis.txt");
  if (!fs.existsSync(synopsisPath)) {
    return "";
  }

  return fs.readFileSync(synopsisPath, "utf-8");
}

// Tool: Write synopsis
async function writeSynopsis(documentId: string, synopsis: string): Promise<string> {
  if (!currentProject) throw new Error("No project open");

  const item = currentProject.binderItems.get(documentId);
  if (!item) throw new Error(`Document not found: ${documentId}`);

  const docFolder = path.join(currentProject.dataPath, documentId);
  if (!fs.existsSync(docFolder)) {
    fs.mkdirSync(docFolder, { recursive: true });
  }

  const synopsisPath = path.join(docFolder, "synopsis.txt");
  fs.writeFileSync(synopsisPath, synopsis, "utf-8");

  // Ensure content.rtf exists (required for Scrivener to show the card on corkboard)
  const contentPath = path.join(docFolder, "content.rtf");
  if (!fs.existsSync(contentPath)) {
    const emptyRtf = "{\\rtf1\\ansi\\ansicpg1252\\uc1\\deff0\n{\\fonttbl{\\f0\\fnil\\fcharset0\\fprq2 TimesNewRomanPSMT;}{\\f1\\fnil\\fcharset0\\fprq2 SitkaText;}}\n{\\colortbl;\\red0\\green0\\blue0;\\red255\\green255\\blue255;\\red128\\green128\\blue128;}\n\\paperw12240\\paperh15840\\margl1800\\margr1800\\margt1440\\margb1440\\f0\\fs24\\cf0\n\\pard\\plain \\ltrch\\loch {\\f1\\fs24 }}";
    fs.writeFileSync(contentPath, emptyRtf, "utf-8");
  }

  // Update modified timestamp
  item.$.Modified = getTimestamp();
  await saveProject();

  return "Synopsis updated successfully";
}

// Tool: Write document
async function writeDocument(documentId: string, content: string): Promise<string> {
  if (!currentProject) throw new Error("No project open");

  const item = currentProject.binderItems.get(documentId);
  if (!item) throw new Error(`Document not found: ${documentId}`);

  const docFolder = path.join(currentProject.dataPath, documentId);
  if (!fs.existsSync(docFolder)) {
    fs.mkdirSync(docFolder, { recursive: true });
  }

  const contentPath = path.join(docFolder, "content.rtf");
  const rtfContent = textToRtf(content);
  fs.writeFileSync(contentPath, rtfContent, "utf-8");

  // Update modified timestamp
  item.$.Modified = getTimestamp();
  await saveProject();

  return "Document updated successfully";
}

// Tool: Create document - THE KEY FIX
async function createDocument(
  title: string,
  parentId?: string,
  documentType: "Text" | "Folder" = "Text",
  content?: string
): Promise<string> {
  if (!currentProject) throw new Error("No project open");

  const uuid = generateUUID();
  const timestamp = getTimestamp();

  // Create the new binder item
  const newItem: BinderItem = {
    $: {
      UUID: uuid,
      Type: documentType,
      Created: timestamp,
      Modified: timestamp,
    },
    Title: [title],
    MetaData: [{ IncludeInCompile: ["Yes"] }],
    TextSettings: [{ TextSelection: ["0,0"] }],
  };

  if (documentType === "Folder") {
    newItem.Children = [{ BinderItem: [] }];
  }

  // Find where to insert
  let targetArray: BinderItem[];

  if (parentId) {
    const parent = currentProject.binderItems.get(parentId);
    if (!parent) throw new Error(`Parent not found: ${parentId}`);

    // Ensure parent has Children structure
    if (!parent.Children) {
      parent.Children = [{ BinderItem: [] }];
    } else if (!parent.Children[0]) {
      parent.Children[0] = { BinderItem: [] };
    } else if (!parent.Children[0].BinderItem) {
      parent.Children[0].BinderItem = [];
    }

    targetArray = parent.Children[0].BinderItem;
  } else {
    // Add to Draft folder by default
    // Scrivener uses type "DraftFolder" for the manuscript root (title can be customized)
    const rootItems = getRootItems(currentProject.xml);
    const draft = rootItems.find(item =>
      item.$.Type === "DraftFolder" ||
      item.Title?.[0] === "Draft" ||
      item.Title?.[0] === "Manuscript"
    );

    if (draft) {
      if (!draft.Children) {
        draft.Children = [{ BinderItem: [] }];
      } else if (!draft.Children[0]) {
        draft.Children[0] = { BinderItem: [] };
      } else if (!draft.Children[0].BinderItem) {
        draft.Children[0].BinderItem = [];
      }
      targetArray = draft.Children[0].BinderItem;
    } else {
      throw new Error("No Draft folder found and no parent specified");
    }
  }

  // Add to binder
  targetArray.push(newItem);

  // Add to our map
  currentProject.binderItems.set(uuid, newItem);

  // Create content file if provided
  if (content) {
    const docFolder = path.join(currentProject.dataPath, uuid);
    fs.mkdirSync(docFolder, { recursive: true });
    const contentPath = path.join(docFolder, "content.rtf");
    fs.writeFileSync(contentPath, textToRtf(content), "utf-8");
  }

  // Save the project
  await saveProject();

  return `Document created: ${uuid}`;
}

// Tool: Delete document (move to trash)
async function deleteDocument(documentId: string): Promise<string> {
  if (!currentProject) throw new Error("No project open");

  const item = currentProject.binderItems.get(documentId);
  if (!item) throw new Error(`Document not found: ${documentId}`);

  // Find and remove from parent
  const rootItems = getRootItems(currentProject.xml);

  function removeFromParent(items: BinderItem[]): boolean {
    for (let i = 0; i < items.length; i++) {
      if (items[i].$.UUID === documentId) {
        items.splice(i, 1);
        return true;
      }
      if (items[i].Children?.[0]?.BinderItem) {
        if (removeFromParent(items[i].Children![0].BinderItem)) {
          return true;
        }
      }
    }
    return false;
  }

  // Find Trash folder
  const trash = rootItems.find(item => item.Title?.[0] === "Trash");
  if (!trash) throw new Error("Trash folder not found");

  // Remove from current location
  removeFromParent(rootItems);

  // Add to trash
  if (!trash.Children) {
    trash.Children = [{ BinderItem: [] }];
  } else if (!trash.Children[0]) {
    trash.Children[0] = { BinderItem: [] };
  } else if (!trash.Children[0].BinderItem) {
    trash.Children[0].BinderItem = [];
  }

  trash.Children[0].BinderItem.push(item);

  await saveProject();

  return `Document moved to trash: ${documentId}`;
}

// Tool: Move document
async function moveDocument(documentId: string, targetFolderId: string, position?: number): Promise<string> {
  if (!currentProject) throw new Error("No project open");

  const item = currentProject.binderItems.get(documentId);
  if (!item) throw new Error(`Document not found: ${documentId}`);

  const target = currentProject.binderItems.get(targetFolderId);
  if (!target) throw new Error(`Target folder not found: ${targetFolderId}`);

  const rootItems = getRootItems(currentProject.xml);

  // Remove from current location
  function removeFromParent(items: BinderItem[]): boolean {
    for (let i = 0; i < items.length; i++) {
      if (items[i].$.UUID === documentId) {
        items.splice(i, 1);
        return true;
      }
      if (items[i].Children?.[0]?.BinderItem) {
        if (removeFromParent(items[i].Children![0].BinderItem)) {
          return true;
        }
      }
    }
    return false;
  }

  removeFromParent(rootItems);

  // Add to target
  if (!target.Children) {
    target.Children = [{ BinderItem: [] }];
  } else if (!target.Children[0]) {
    target.Children[0] = { BinderItem: [] };
  } else if (!target.Children[0].BinderItem) {
    target.Children[0].BinderItem = [];
  }

  if (position !== undefined && position >= 0) {
    target.Children[0].BinderItem.splice(position, 0, item);
  } else {
    target.Children[0].BinderItem.push(item);
  }

  // Update modified timestamp
  item.$.Modified = getTimestamp();

  await saveProject();

  return `Document moved successfully`;
}

// Tool: Rename document
async function renameDocument(documentId: string, newTitle: string): Promise<string> {
  if (!currentProject) throw new Error("No project open");
  if (!newTitle || newTitle.trim() === "") throw new Error("Document title cannot be empty");

  const item = currentProject.binderItems.get(documentId);
  if (!item) throw new Error(`Document not found: ${documentId}`);

  item.Title = [newTitle];
  item.$.Modified = getTimestamp();

  await saveProject();

  return `Document renamed to: ${newTitle}`;
}

// Tool: Search content
async function searchContent(query: string): Promise<any[]> {
  if (!currentProject) throw new Error("No project open");
  if (!query || query.trim() === "") return [];

  const results: any[] = [];
  const queryLower = query.toLowerCase();

  for (const [uuid, item] of currentProject.binderItems) {
    // Check title
    const title = item.Title?.[0] || "";
    if (title.toLowerCase().includes(queryLower)) {
      results.push({ uuid, title, match: "title" });
      continue;
    }

    // Check content
    try {
      const content = await readDocument(uuid) as string;
      if (content.toLowerCase().includes(queryLower)) {
        results.push({ uuid, title, match: "content" });
      }
    } catch {
      // Skip documents without content
    }
  }

  return results;
}

// Types for compile
interface CompileItem {
  uuid: string;
  title: string;
  type: string;
  depth: number;
  includeInCompile: boolean;
}

// Helper: Get documents in compile order from Draft folder
function getCompileOrder(stopAtTitle?: string): CompileItem[] {
  if (!currentProject) throw new Error("No project open");

  const results: CompileItem[] = [];
  const rootItems = getRootItems(currentProject.xml);

  // Find Draft/Manuscript folder
  const draft = rootItems.find(item =>
    item.$.Type === "DraftFolder" ||
    item.Title?.[0] === "Draft" ||
    item.Title?.[0] === "Manuscript"
  );

  if (!draft) return results;

  let shouldStop = false;

  function traverse(items: BinderItem[], depth: number) {
    if (shouldStop) return;

    for (const item of items) {
      if (shouldStop) return;

      const title = item.Title?.[0] || "Untitled";
      const includeInCompile = item.MetaData?.[0]?.IncludeInCompile?.[0] === "Yes";

      results.push({
        uuid: item.$.UUID,
        title,
        type: item.$.Type,
        depth,
        includeInCompile
      });

      // Check if we should stop after this item
      if (stopAtTitle && title.toLowerCase().includes(stopAtTitle.toLowerCase())) {
        shouldStop = true;
        return;
      }

      // Recurse into children
      if (item.Children && item.Children[0]?.BinderItem) {
        traverse(item.Children[0].BinderItem, depth + 1);
      }
    }
  }

  if (draft.Children && draft.Children[0]?.BinderItem) {
    traverse(draft.Children[0].BinderItem, 0);
  }

  return results;
}

// Tool: Get compile order
async function getCompileOrderTool(stopAtTitle?: string): Promise<CompileItem[]> {
  return getCompileOrder(stopAtTitle);
}

// Helper: Parse markdown-style formatting and write to PDF
// Handles *italic*, **bold**, and ***bold italic***
function writeFormattedText(
  doc: InstanceType<typeof PDFDocument>,
  text: string,
  fontSize: number,
  continued: boolean = false
): void {
  // Regex to match formatting: ***bold italic***, **bold**, *italic*
  const formatRegex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*)/g;

  let lastIndex = 0;
  let match;
  const segments: { text: string; bold: boolean; italic: boolean }[] = [];

  while ((match = formatRegex.exec(text)) !== null) {
    // Add text before match as plain
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), bold: false, italic: false });
    }

    // Determine formatting type
    if (match[2]) {
      // ***bold italic***
      segments.push({ text: match[2], bold: true, italic: true });
    } else if (match[3]) {
      // **bold**
      segments.push({ text: match[3], bold: true, italic: false });
    } else if (match[4]) {
      // *italic*
      segments.push({ text: match[4], bold: false, italic: true });
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), bold: false, italic: false });
  }

  // If no segments, just write plain text
  if (segments.length === 0) {
    doc.font("Times-Roman").fontSize(fontSize).text(text, { continued });
    return;
  }

  // Write each segment with appropriate font
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;

    // Select font based on formatting
    if (seg.bold && seg.italic) {
      doc.font("Times-BoldItalic");
    } else if (seg.bold) {
      doc.font("Times-Bold");
    } else if (seg.italic) {
      doc.font("Times-Italic");
    } else {
      doc.font("Times-Roman");
    }

    doc.fontSize(fontSize).text(seg.text, { continued: !isLast || continued });
  }
}

// Tool: Compile manuscript to PDF
async function compileManuscript(
  outputPath: string,
  options?: {
    stopAtTitle?: string;
    includeTitle?: boolean;
    fontSize?: number;
    lineSpacing?: number;
    title?: string;
    author?: string;
  }
): Promise<string> {
  if (!currentProject) throw new Error("No project open");

  const {
    stopAtTitle,
    includeTitle = true,
    fontSize = 12,
    lineSpacing = 1.5,
    title,
    author
  } = options || {};

  // Get documents to compile
  const compileItems = getCompileOrder(stopAtTitle);
  const itemsToCompile = compileItems.filter(item =>
    item.includeInCompile && item.type === "Text"
  );

  if (itemsToCompile.length === 0) {
    throw new Error("No documents marked for compile");
  }

  // Use provided title or fall back to project filename
  const pdfTitle = title || path.basename(currentProject.path, ".scriv");

  // Create PDF with metadata
  const doc = new PDFDocument({
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    size: "LETTER",
    info: {
      Title: pdfTitle,
      Author: author || "",
      Creator: "Scrivener MCP Server",
      Producer: "PDFKit"
    }
  });

  // Pipe to file
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  // Title page
  doc.font("Times-Bold").fontSize(24).text(pdfTitle, { align: "center" });
  doc.moveDown(2);
  if (author) {
    doc.font("Times-Roman").fontSize(14).text(`by ${author}`, { align: "center" });
    doc.moveDown(4);
  }
  doc.font("Times-Roman").fontSize(12).text(`Compiled: ${new Date().toLocaleDateString()}`, { align: "center" });
  doc.addPage();

  // Compile each document
  let isFirstChapter = true;
  for (const item of itemsToCompile) {
    // Read document content
    let content: string;
    try {
      content = await readDocument(item.uuid) as string;
    } catch {
      continue; // Skip documents without content
    }

    if (!content.trim()) continue;

    // Add page break between chapters (except first)
    if (!isFirstChapter) {
      doc.addPage();
    }
    isFirstChapter = false;

    // Add chapter title if requested
    if (includeTitle) {
      doc.font("Times-Bold").fontSize(18).text(item.title, { align: "center" });
      doc.moveDown(1.5);
    }

    // Split content into paragraphs and write with proper spacing
    const paragraphs = content.split('\n').filter(p => p.trim());

    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i].trim();

      // Write paragraph with formatting support
      writeFormattedText(doc, para, fontSize);

      // Add paragraph spacing (half line between paragraphs)
      if (i < paragraphs.length - 1) {
        doc.moveDown(lineSpacing * 0.5);
      }
    }
  }

  // Finalize PDF
  doc.end();

  // Wait for stream to finish
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return `Compiled ${itemsToCompile.length} documents to ${outputPath}`;
}

// Tool: Get word count for a document or entire project
async function wordCount(documentId?: string): Promise<{ documentId?: string; title?: string; wordCount: number; characterCount: number }> {
  if (!currentProject) throw new Error("No project open");

  if (documentId) {
    // Count single document
    const item = currentProject.binderItems.get(documentId);
    if (!item) throw new Error(`Document not found: ${documentId}`);

    const content = await readDocument(documentId) as string;
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    return {
      documentId,
      title: item.Title?.[0] || "Untitled",
      wordCount: words,
      characterCount: content.length
    };
  }

  // Count entire project (Draft folder)
  const compileItems = getCompileOrder();
  let totalWords = 0;
  let totalChars = 0;

  for (const item of compileItems) {
    if (item.type === "Text") {
      try {
        const content = await readDocument(item.uuid) as string;
        totalWords += content.trim() ? content.trim().split(/\s+/).length : 0;
        totalChars += content.length;
      } catch {
        // Skip documents without content
      }
    }
  }

  return { wordCount: totalWords, characterCount: totalChars };
}

// Tool: Append content to a document
async function appendToDocument(documentId: string, content: string, separator?: string): Promise<string> {
  if (!currentProject) throw new Error("No project open");

  const item = currentProject.binderItems.get(documentId);
  if (!item) throw new Error(`Document not found: ${documentId}`);

  // Read existing content
  let existing = "";
  try {
    existing = await readDocument(documentId) as string;
  } catch {
    // Document may not have content yet
  }

  // Append with separator
  const sep = separator ?? "\n\n";
  const newContent = existing ? existing + sep + content : content;

  // Write back
  await writeDocument(documentId, newContent);
  return "Content appended successfully";
}

// Tool: Set include in compile flag
async function setIncludeInCompile(documentId: string, include: boolean): Promise<string> {
  if (!currentProject) throw new Error("No project open");

  const item = currentProject.binderItems.get(documentId);
  if (!item) throw new Error(`Document not found: ${documentId}`);

  // Ensure MetaData structure exists
  if (!item.MetaData) {
    item.MetaData = [{}];
  }
  if (!item.MetaData[0]) {
    item.MetaData[0] = {};
  }

  item.MetaData[0].IncludeInCompile = [include ? "Yes" : "No"];
  item.$.Modified = getTimestamp();

  await saveProject();
  return `Document ${include ? "included in" : "excluded from"} compile`;
}

// Tool: Read document notes
async function readNotes(documentId: string): Promise<string> {
  if (!currentProject) throw new Error("No project open");

  const item = currentProject.binderItems.get(documentId);
  if (!item) throw new Error(`Document not found: ${documentId}`);

  const notesPath = path.join(currentProject.dataPath, documentId, "notes.rtf");
  if (!fs.existsSync(notesPath)) {
    return "";
  }

  const rtfContent = fs.readFileSync(notesPath, "utf-8");
  return rtfToText(rtfContent);
}

// Tool: Write document notes
async function writeNotes(documentId: string, notes: string): Promise<string> {
  if (!currentProject) throw new Error("No project open");

  const item = currentProject.binderItems.get(documentId);
  if (!item) throw new Error(`Document not found: ${documentId}`);

  const docFolder = path.join(currentProject.dataPath, documentId);
  if (!fs.existsSync(docFolder)) {
    fs.mkdirSync(docFolder, { recursive: true });
  }

  const notesPath = path.join(docFolder, "notes.rtf");
  const rtfContent = textToRtf(notes);
  fs.writeFileSync(notesPath, rtfContent, "utf-8");

  item.$.Modified = getTimestamp();
  await saveProject();

  return "Notes updated successfully";
}

// Tool: Batch read multiple documents
async function batchRead(documentIds: string[]): Promise<{ uuid: string; title: string; content: string }[]> {
  if (!currentProject) throw new Error("No project open");

  const results: { uuid: string; title: string; content: string }[] = [];

  for (const docId of documentIds) {
    const item = currentProject.binderItems.get(docId);
    if (!item) continue;

    try {
      const content = await readDocument(docId) as string;
      results.push({
        uuid: docId,
        title: item.Title?.[0] || "Untitled",
        content
      });
    } catch {
      results.push({
        uuid: docId,
        title: item.Title?.[0] || "Untitled",
        content: ""
      });
    }
  }

  return results;
}

// Tool: Search with context - returns matches with surrounding paragraphs
async function searchWithContext(
  query: string,
  contextParagraphs: number = 2
): Promise<{ uuid: string; title: string; matches: { context: string; position: number }[] }[]> {
  if (!currentProject) throw new Error("No project open");

  const results: { uuid: string; title: string; matches: { context: string; position: number }[] }[] = [];
  const queryLower = query.toLowerCase();

  for (const [uuid, item] of currentProject.binderItems) {
    try {
      const content = await readDocument(uuid) as string;
      if (!content.toLowerCase().includes(queryLower)) continue;

      const paragraphs = content.split(/\n\n+/);
      const matches: { context: string; position: number }[] = [];

      for (let i = 0; i < paragraphs.length; i++) {
        if (paragraphs[i].toLowerCase().includes(queryLower)) {
          // Get surrounding paragraphs
          const start = Math.max(0, i - contextParagraphs);
          const end = Math.min(paragraphs.length, i + contextParagraphs + 1);
          const context = paragraphs.slice(start, end).join("\n\n");
          matches.push({ context, position: i });
        }
      }

      if (matches.length > 0) {
        results.push({
          uuid,
          title: item.Title?.[0] || "Untitled",
          matches
        });
      }
    } catch {
      // Skip documents without content
    }
  }

  return results;
}

// Tool: Find all mentions of a term across the manuscript
async function findAllMentions(
  term: string
): Promise<{ uuid: string; title: string; mentions: string[] }[]> {
  if (!currentProject) throw new Error("No project open");

  const results: { uuid: string; title: string; mentions: string[] }[] = [];
  const termLower = term.toLowerCase();

  for (const [uuid, item] of currentProject.binderItems) {
    try {
      const content = await readDocument(uuid) as string;
      if (!content.toLowerCase().includes(termLower)) continue;

      // Find sentences containing the term
      const sentences = content.split(/(?<=[.!?])\s+/);
      const mentions = sentences.filter(s => s.toLowerCase().includes(termLower));

      if (mentions.length > 0) {
        results.push({
          uuid,
          title: item.Title?.[0] || "Untitled",
          mentions
        });
      }
    } catch {
      // Skip documents without content
    }
  }

  return results;
}

// Tool: Compare descriptions - find unique descriptive sentences for a term
async function compareDescriptions(
  term: string
): Promise<{ term: string; descriptions: { uuid: string; title: string; sentence: string }[] }> {
  if (!currentProject) throw new Error("No project open");

  const descriptions: { uuid: string; title: string; sentence: string }[] = [];
  const termLower = term.toLowerCase();
  const seenSentences = new Set<string>();

  // Patterns that suggest description: "was", "had", "wore", "'s", "looked", "appeared"
  const descPatterns = /\b(was|were|had|has|wore|wears|looked|looks|appeared|appears|seemed|seems)\b|'s\s/i;

  for (const [uuid, item] of currentProject.binderItems) {
    try {
      const content = await readDocument(uuid) as string;
      if (!content.toLowerCase().includes(termLower)) continue;

      const sentences = content.split(/(?<=[.!?])\s+/);

      for (const sentence of sentences) {
        if (sentence.toLowerCase().includes(termLower) && descPatterns.test(sentence)) {
          const normalized = sentence.trim().toLowerCase();
          if (!seenSentences.has(normalized)) {
            seenSentences.add(normalized);
            descriptions.push({
              uuid,
              title: item.Title?.[0] || "Untitled",
              sentence: sentence.trim()
            });
          }
        }
      }
    } catch {
      // Skip documents without content
    }
  }

  return { term, descriptions };
}

// Set up MCP server
const server = new Server(
  { name: "scrivener-mcp-server", version: "1.3.2" },
  { capabilities: { tools: {} } }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "open_project",
      description: "Open a Scrivener project (.scriv folder)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the .scriv project folder" },
        },
        required: ["path"],
      },
    },
    {
      name: "get_structure",
      description: "Get the hierarchical structure of the project binder",
      inputSchema: {
        type: "object",
        properties: {
          folderId: { type: "string", description: "Optional: Get structure for specific folder only" },
          maxDepth: { type: "number", description: "Optional: Maximum depth to traverse" },
        },
      },
    },
    {
      name: "read_document",
      description: "Read the content of a document. Optionally includes synopsis (index card text).",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "UUID of the document" },
          includeSynopsis: { type: "boolean", description: "If true, returns { content, synopsis } object instead of just content string" },
        },
        required: ["documentId"],
      },
    },
    {
      name: "write_document",
      description: "Write content to an existing document",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "UUID of the document" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["documentId", "content"],
      },
    },
    {
      name: "create_document",
      description: "Create a new document or folder in the project",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Title of the new document" },
          parentId: { type: "string", description: "UUID of parent folder (optional, defaults to Draft)" },
          documentType: { type: "string", enum: ["Text", "Folder"], description: "Type of document" },
          content: { type: "string", description: "Initial content (optional)" },
        },
        required: ["title"],
      },
    },
    {
      name: "delete_document",
      description: "Move a document to trash",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "UUID of the document to delete" },
        },
        required: ["documentId"],
      },
    },
    {
      name: "move_document",
      description: "Move a document to a different folder",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "UUID of the document to move" },
          targetFolderId: { type: "string", description: "UUID of the target folder" },
          position: { type: "number", description: "Position in target folder (optional)" },
        },
        required: ["documentId", "targetFolderId"],
      },
    },
    {
      name: "rename_document",
      description: "Rename a document",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "UUID of the document" },
          newTitle: { type: "string", description: "New title" },
        },
        required: ["documentId", "newTitle"],
      },
    },
    {
      name: "search_content",
      description: "Search for content across all documents",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
    {
      name: "read_synopsis",
      description: "Read the synopsis (index card text) of a document",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "UUID of the document" },
        },
        required: ["documentId"],
      },
    },
    {
      name: "write_synopsis",
      description: "Write or update the synopsis (index card text) of a document",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "UUID of the document" },
          synopsis: { type: "string", description: "Synopsis text to write" },
        },
        required: ["documentId", "synopsis"],
      },
    },
    {
      name: "get_compile_order",
      description: "Get the list of documents in compile order from the Draft/Manuscript folder. Useful for seeing what will be included in a compile.",
      inputSchema: {
        type: "object",
        properties: {
          stopAtTitle: { type: "string", description: "Optional: Stop at document with this title (partial match). E.g., 'Chapter 7' to get everything up to and including Chapter 7" },
        },
      },
    },
    {
      name: "compile_manuscript",
      description: "Compile the manuscript to a PDF file. Only includes documents marked 'Include in Compile'.",
      inputSchema: {
        type: "object",
        properties: {
          outputPath: { type: "string", description: "Full path for the output PDF file" },
          title: { type: "string", description: "Book title for cover page and PDF metadata (default: project filename)" },
          author: { type: "string", description: "Author name for cover page and PDF metadata" },
          stopAtTitle: { type: "string", description: "Optional: Stop at document with this title (partial match). E.g., 'Chapter 7'" },
          includeTitle: { type: "boolean", description: "Include document titles as chapter headers (default: true)" },
          fontSize: { type: "number", description: "Font size in points (default: 12)" },
          lineSpacing: { type: "number", description: "Line spacing multiplier (default: 1.5)" },
        },
        required: ["outputPath"],
      },
    },
    {
      name: "word_count",
      description: "Get word count for a specific document or the entire manuscript",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "UUID of document to count (omit for entire manuscript)" },
        },
      },
    },
    {
      name: "append_to_document",
      description: "Append content to the end of an existing document without replacing existing content",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "UUID of the document" },
          content: { type: "string", description: "Content to append" },
          separator: { type: "string", description: "Separator between existing and new content (default: two newlines)" },
        },
        required: ["documentId", "content"],
      },
    },
    {
      name: "set_include_in_compile",
      description: "Set whether a document should be included in compile",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "UUID of the document" },
          include: { type: "boolean", description: "True to include, false to exclude" },
        },
        required: ["documentId", "include"],
      },
    },
    {
      name: "read_notes",
      description: "Read the notes (inspector notes) for a document",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "UUID of the document" },
        },
        required: ["documentId"],
      },
    },
    {
      name: "write_notes",
      description: "Write or update the notes (inspector notes) for a document",
      inputSchema: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "UUID of the document" },
          notes: { type: "string", description: "Notes content to write" },
        },
        required: ["documentId", "notes"],
      },
    },
    {
      name: "batch_read",
      description: "Read multiple documents at once. More efficient than multiple read_document calls.",
      inputSchema: {
        type: "object",
        properties: {
          documentIds: { type: "array", items: { type: "string" }, description: "Array of document UUIDs to read" },
        },
        required: ["documentIds"],
      },
    },
    {
      name: "search_with_context",
      description: "Search for a term and return matches with surrounding paragraphs for context",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term" },
          contextParagraphs: { type: "number", description: "Number of paragraphs before/after match to include (default: 2)" },
        },
        required: ["query"],
      },
    },
    {
      name: "find_all_mentions",
      description: "Find all sentences mentioning a term across the manuscript. Useful for checking character/place consistency.",
      inputSchema: {
        type: "object",
        properties: {
          term: { type: "string", description: "Term to search for (e.g., character name)" },
        },
        required: ["term"],
      },
    },
    {
      name: "compare_descriptions",
      description: "Find all descriptive sentences for a term (sentences with 'was', 'had', 'looked', etc.). Helps identify inconsistent descriptions.",
      inputSchema: {
        type: "object",
        properties: {
          term: { type: "string", description: "Term to find descriptions for (e.g., 'Sarah', 'the house')" },
        },
        required: ["term"],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error("No arguments provided");
  }

  try {
    let result: any;

    switch (name) {
      case "open_project":
        result = await openProject(args.path as string);
        break;
      case "get_structure":
        result = await getStructure(args.folderId as string | undefined, args.maxDepth as number | undefined);
        break;
      case "read_document":
        result = await readDocument(args.documentId as string, args.includeSynopsis as boolean | undefined);
        break;
      case "write_document":
        result = await writeDocument(args.documentId as string, args.content as string);
        break;
      case "create_document":
        result = await createDocument(
          args.title as string,
          args.parentId as string | undefined,
          (args.documentType as "Text" | "Folder") || "Text",
          args.content as string | undefined
        );
        break;
      case "delete_document":
        result = await deleteDocument(args.documentId as string);
        break;
      case "move_document":
        result = await moveDocument(
          args.documentId as string,
          args.targetFolderId as string,
          args.position as number | undefined
        );
        break;
      case "rename_document":
        result = await renameDocument(args.documentId as string, args.newTitle as string);
        break;
      case "search_content":
        result = await searchContent(args.query as string);
        break;
      case "read_synopsis":
        result = await readSynopsis(args.documentId as string);
        break;
      case "write_synopsis":
        result = await writeSynopsis(args.documentId as string, args.synopsis as string);
        break;
      case "get_compile_order":
        result = await getCompileOrderTool(args.stopAtTitle as string | undefined);
        break;
      case "compile_manuscript":
        result = await compileManuscript(args.outputPath as string, {
          stopAtTitle: args.stopAtTitle as string | undefined,
          includeTitle: args.includeTitle as boolean | undefined,
          fontSize: args.fontSize as number | undefined,
          lineSpacing: args.lineSpacing as number | undefined,
          title: args.title as string | undefined,
          author: args.author as string | undefined,
        });
        break;
      case "word_count":
        result = await wordCount(args.documentId as string | undefined);
        break;
      case "append_to_document":
        result = await appendToDocument(
          args.documentId as string,
          args.content as string,
          args.separator as string | undefined
        );
        break;
      case "set_include_in_compile":
        result = await setIncludeInCompile(args.documentId as string, args.include as boolean);
        break;
      case "read_notes":
        result = await readNotes(args.documentId as string);
        break;
      case "write_notes":
        result = await writeNotes(args.documentId as string, args.notes as string);
        break;
      case "batch_read":
        result = await batchRead(args.documentIds as string[]);
        break;
      case "search_with_context":
        result = await searchWithContext(
          args.query as string,
          args.contextParagraphs as number | undefined
        );
        break;
      case "find_all_mentions":
        result = await findAllMentions(args.term as string);
        break;
      case "compare_descriptions":
        result = await compareDescriptions(args.term as string);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Scrivener MCP server running");
}

main().catch(console.error);
