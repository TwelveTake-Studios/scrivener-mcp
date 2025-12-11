# Scrivener MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that lets AI assistants read, write, and organize [Scrivener](https://www.literatureandlatte.com/scrivener/overview) projects. Works with Claude, ChatGPT, Gemini, and other MCP-compatible AI tools.

## Features

- **Read & Write** - Full access to manuscript content, notes, and synopses
- **Organize** - Create, move, rename, and delete documents and folders
- **Search** - Find content across your entire project with context
- **Compile** - Export your manuscript to PDF directly from AI
- **Continuity Tools** - Check character/setting consistency across your manuscript

Perfect for writers who want AI assistance with drafting, revision, outlining, or project organization.

## Requirements

- Node.js 18 or higher
- Scrivener 3 (macOS or Windows)
- An MCP-compatible AI client (Claude Desktop, ChatGPT Desktop, Cursor, etc.)

## Installation

### Option 1: npm (Recommended)

```bash
npm install -g @twelvetake/scrivener-mcp
```

Then add to your MCP client's configuration. For Claude Desktop (`claude_desktop_config.json`):

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "scrivener": {
      "command": "scrivener-mcp"
    }
  }
}
```

### Option 2: From Source

1. Clone and build:
   ```bash
   git clone https://github.com/TwelveTake-Studios/scrivener-mcp.git
   cd scrivener-mcp
   npm install
   npm run build
   ```

2. Add to your Claude Desktop configuration:
   ```json
   {
     "mcpServers": {
       "scrivener": {
         "command": "node",
         "args": ["/full/path/to/scrivener-mcp/dist/index.js"]
       }
     }
   }
   ```

3. Restart Claude Desktop

## Quick Start

Once installed, try these commands with your AI assistant:

```
Open my Scrivener project at /path/to/mynovel.scriv
```

```
Show me the structure of my manuscript
```

```
Read Chapter 3
```

```
Create a new scene called "The Confrontation" in Chapter 5
```

```
Compile everything up to Chapter 7 into a PDF
```

```
Find all mentions of "Sarah" and check if her descriptions are consistent
```

---

## Available Tools (22 total)

### Project Management

| Tool | Description |
|------|-------------|
| `open_project` | Open a Scrivener project (.scriv folder) |
| `get_structure` | Get the hierarchical structure of the project binder |

### Document Operations

| Tool | Description |
|------|-------------|
| `read_document` | Read content from a document (optionally includes synopsis) |
| `write_document` | Write/replace content in a document |
| `append_to_document` | Append content to end of document without replacing |
| `create_document` | Create new documents or folders |
| `delete_document` | Move documents to trash |
| `move_document` | Reorganize items in the binder |
| `rename_document` | Rename documents |
| `batch_read` | Read multiple documents at once (more efficient) |

### Synopsis & Notes

| Tool | Description |
|------|-------------|
| `read_synopsis` | Read the synopsis (index card text) |
| `write_synopsis` | Write/update the synopsis |
| `read_notes` | Read inspector notes for a document |
| `write_notes` | Write/update inspector notes |

### Search

| Tool | Description |
|------|-------------|
| `search_content` | Search across all documents |
| `search_with_context` | Search with surrounding paragraphs for context |

### Compile & Export

| Tool | Description |
|------|-------------|
| `get_compile_order` | Preview what will be compiled |
| `compile_manuscript` | Export manuscript to PDF |
| `set_include_in_compile` | Toggle document's "Include in Compile" setting |
| `word_count` | Get word count for document or entire manuscript |

### Continuity Checking

| Tool | Description |
|------|-------------|
| `find_all_mentions` | Find all sentences mentioning a term |
| `compare_descriptions` | Find descriptive sentences to check consistency |

---

## Tool Reference

### open_project

Open a Scrivener project to work with.

**Parameters:**
- `path` (required): Path to the .scriv project folder

**Example:**
```
Open my project at D:/Writing/MyNovel.scriv
```

---

### get_structure

View the binder hierarchy of your project.

**Parameters:**
- `folderId` (optional): Get structure for specific folder only
- `maxDepth` (optional): Maximum depth to traverse

**Example:**
```
Show me the structure of my manuscript
Show me only what's in Chapter 3
```

---

### read_document

Read the content of a document.

**Parameters:**
- `documentId` (required): UUID of the document
- `includeSynopsis` (optional): If true, returns both content and synopsis

**Example:**
```
Read the content of "Chapter 1 - The Beginning"
Read Chapter 3 with its synopsis
```

---

### write_document

Replace the content of a document.

**Parameters:**
- `documentId` (required): UUID of the document
- `content` (required): New content to write

**Example:**
```
Replace the content of Scene 2 with the revised version
```

---

### append_to_document

Add content to the end of a document without replacing existing content.

**Parameters:**
- `documentId` (required): UUID of the document
- `content` (required): Content to append
- `separator` (optional): Separator between existing and new content (default: two newlines)

**Example:**
```
Append this new paragraph to Chapter 5
Add these notes to the end of the scene
```

---

### create_document

Create a new document or folder.

**Parameters:**
- `title` (required): Title of the new document
- `parentId` (optional): UUID of parent folder (defaults to Draft/Manuscript)
- `documentType` (optional): "Text" or "Folder" (default: "Text")
- `content` (optional): Initial content

**Example:**
```
Create a new chapter called "The Escape"
Create a folder called "Act Two" and add three scenes to it
```

---

### delete_document

Move a document to the trash.

**Parameters:**
- `documentId` (required): UUID of the document to delete

**Example:**
```
Delete the scene called "Old Draft"
```

---

### move_document

Move a document to a different folder.

**Parameters:**
- `documentId` (required): UUID of the document to move
- `targetFolderId` (required): UUID of the target folder
- `position` (optional): Position in target folder

**Example:**
```
Move "The Discovery" scene to Chapter 4
```

---

### rename_document

Rename a document.

**Parameters:**
- `documentId` (required): UUID of the document
- `newTitle` (required): New title

**Example:**
```
Rename "Untitled Scene" to "The Confrontation"
```

---

### batch_read

Read multiple documents at once. More efficient than multiple read_document calls.

**Parameters:**
- `documentIds` (required): Array of document UUIDs to read

**Example:**
```
Read all the scenes in Chapter 2
```

---

### read_synopsis / write_synopsis

Read or write the synopsis (index card text) for a document.

**Parameters:**
- `documentId` (required): UUID of the document
- `synopsis` (required for write): Synopsis text

**Example:**
```
Show me the synopsis for Chapter 3
Update the synopsis for "The Chase" to summarize the new version
```

---

### read_notes / write_notes

Read or write inspector notes for a document.

**Parameters:**
- `documentId` (required): UUID of the document
- `notes` (required for write): Notes content

**Example:**
```
Show me my notes for Scene 5
Add a note to Chapter 2 about the timeline
```

---

### search_content

Search for content across all documents.

**Parameters:**
- `query` (required): Search query

**Example:**
```
Search for mentions of "the artifact"
Find all scenes that reference the castle
```

---

### search_with_context

Search with surrounding paragraphs for better context.

**Parameters:**
- `query` (required): Search term
- `contextParagraphs` (optional): Paragraphs before/after to include (default: 2)

**Example:**
```
Search for "the ritual" with 3 paragraphs of context
```

---

### get_compile_order

Preview what documents will be compiled and in what order.

**Parameters:**
- `stopAtTitle` (optional): Stop at document with this title (partial match)

**Example:**
```
Show me the compile order
What would be compiled up to Chapter 5?
```

---

### compile_manuscript

Compile the manuscript to a PDF file.

**Parameters:**
- `outputPath` (required): Full path for the output PDF
- `title` (optional): Book title for cover page and PDF metadata (default: project filename)
- `author` (optional): Author name for cover page and PDF metadata
- `stopAtTitle` (optional): Stop at document with this title
- `includeTitle` (optional): Include document titles as headers (default: true)
- `fontSize` (optional): Font size in points (default: 12)
- `lineSpacing` (optional): Line spacing multiplier (default: 1.5)

**Example:**
```
Compile my full manuscript to D:/Writing/MyNovel.pdf
Compile with title "Keystone: Aftermath" by Dave Cilluffo
Compile everything up to Chapter 7 to D:/Writing/Draft.pdf
Compile with 14pt font and double spacing
```

---

### set_include_in_compile

Toggle whether a document should be included when compiling.

**Parameters:**
- `documentId` (required): UUID of the document
- `include` (required): true to include, false to exclude

**Example:**
```
Exclude the "Notes" document from compile
Include "Deleted Scene" back in the compile
```

---

### word_count

Get word count for a specific document or the entire manuscript.

**Parameters:**
- `documentId` (optional): UUID of document (omit for entire manuscript)

**Example:**
```
How many words are in my manuscript?
What's the word count for Chapter 3?
```

---

### find_all_mentions

Find all sentences mentioning a term. Great for character/setting consistency checks.

**Parameters:**
- `term` (required): Term to search for (e.g., character name)

**Example:**
```
Find all mentions of "Sarah"
Show me every sentence that mentions "the lighthouse"
```

---

### compare_descriptions

Find descriptive sentences for a term (sentences with "was", "had", "looked", etc.). Helps identify inconsistent descriptions.

**Parameters:**
- `term` (required): Term to find descriptions for

**Example:**
```
Find all descriptions of Sarah
Check how I've described the mansion throughout the book
Are my descriptions of Marcus consistent?
```

---

## Important Notes

- **Close Scrivener first** before using this server to avoid conflicts
- The server modifies the `.scrivx` binder file and RTF content files directly
- Always keep backups of important projects
- Only documents marked "Include in Compile" are included in PDF export
- This is an unofficial tool and is not affiliated with Literature & Latte

## How It Works

Scrivener projects (`.scriv` folders) contain:
- A `.scrivx` XML file that defines the binder structure
- Individual RTF files for each document's content
- Synopsis and notes stored as plain text and RTF files

This server parses and modifies these files directly, allowing AI assistants to interact with your project programmatically.

## Support This Project

If you find this useful, consider supporting development:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?style=flat&logo=buy-me-a-coffee)](https://buymeacoffee.com/twelvetake)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-ff5e5b?style=flat&logo=ko-fi)](https://ko-fi.com/twelvetake)

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Changelog

### v1.3.2
- **Added title/author to compile** - `compile_manuscript` now accepts `title` and `author` parameters for cover page and PDF metadata

### v1.3.1
- **Fixed PDF compile formatting** - Paragraphs now have proper spacing instead of running together
- **Added text formatting to PDF** - Bold, italic, and bold-italic are now rendered in compiled PDFs
- **Improved chapter titles** - Larger font (18pt), bold, with better spacing

### v1.3.0
- **Added utility tools**: `word_count`, `append_to_document`, `set_include_in_compile`, `read_notes`, `write_notes`, `batch_read`
- **Added continuity tools**: `search_with_context`, `find_all_mentions`, `compare_descriptions`
- 22 tools total

### v1.2.0
- **Added compile features**: `get_compile_order`, `compile_manuscript` (PDF export via pdfkit)
- Compile supports partial export with `stopAtTitle` parameter
- Added synopsis tools: `read_synopsis`, `write_synopsis`

### v1.1.3
- **Fixed empty paragraph handling** - Empty lines no longer cause extra spacing in compiled output

### v1.1.2
- **Fixed RTF paragraph formatting** - Resolved issue where `\par\par` patterns caused section breaks in Scrivener compile

### v1.0.1
- **Fixed DraftFolder detection** - `create_document` now finds the manuscript root by type (`DraftFolder`) instead of requiring title to be "Draft" or "Manuscript"
- **Fixed empty search query** - `search_content` with empty query now returns empty array
- **Fixed empty rename validation** - `rename_document` rejects empty titles

### v1.0.0
- Initial release with 11 core tools
- Custom RTF parser with formatting preservation
- Support for bold, italic, em-dash, en-dash

## Credits

Developed by Dave Cilluffo / [TwelveTake Studios](https://twelvetake.com)

Scrivener is a registered trademark of [Literature & Latte Ltd](https://www.literatureandlatte.com/).
