# 🚀 Team Coding & Security Policy – Vanilla JavaScript

> **Scope** – All production code in this repository is **pure vanilla JavaScript** (ES‑2015+).  
> **Third‑party dependencies** are prohibited unless they are *absolutely unavoidable* or *explicitly approved* after a formal review that documents the cyber‑risk benefit (or at least the reduction in risk).  

Below you’ll find the updated **Code‑Style Guide** followed by the **Third‑Party Import Policy**.  
Add these files to the repo root (`STYLE_GUIDE.md` and `THIRD_PARTY_POLICY.md`) and reference them in your README.

---

## 1️⃣ General Formatting Rules

| Feature | Guideline | Rationale |
|---------|-----------|-----------|
| **Line length** | *Not enforced*. Write as many characters per line as needed for readability. | 80‑char limit is too restrictive for logic‑heavy JS. |
| **File endings** | No mandatory newline at EOF. | Keeps repo size minimal. |
| **Semicolons** | **Mandatory** (`;`) and must end the statement on its own line. | Avoids accidental “AS​I‑style” bugs and keeps diffs tidy. |
| **Indentation** | 4 spaces per level – never tabs. | Uniform visual depth. |
| **Quotes** | Single quotes (`'`) for strings (unless a single quote is required inside). | Consistency. |
| **Trailing commas** | Mandatory on multiline objects/arrays. | Easier diffs when adding fields. |
| **`var`** | **Never** use `var`. Prefer `const` or `let`. | Modern JS, avoids hoisting surprises. |
| **Blank lines** | Add a blank line after any statement that ends with a semicolon. | Keeps logical blocks separated. |

---

## 2️⃣ Braces & Parentheses

### 2.1 Opening `{` or `(`

| Context | Placement | Example |
|---------|-----------|---------|
| **After a colon** (`:`) – e.g. object property value | Same line is allowed | `key: { a: 1, b: 2 }` |
| **After a comma** – e.g. array element or object‑property list | **Must** start on a *new line* | `[ { a: 1 }, { b: 2 } ]` → each object opens on its own line |
| **After any other token** (e.g. function arguments, if‑condition, etc.) | **Must** start on a new line | `fn(a, b, { c: 3 })` → the object after the comma opens on a new line |

> **Opening brace/parenthesis** *cannot* follow a token that is *not* a colon. After a comma or any other token it *must* be on its own line.

### 2.2 Closing `}` or `)`

| Situation | Placement | Example |
|-----------|-----------|---------|
| **Single item inside** – e.g. `{ a: 1 }` | Can stay on the same line | `const one = { key: value };` |
| **Multiple items** – e.g. an object with two keys | Closing brace must start on its own line, aligned with the opening brace | `const obj = { a: 1, b: 2 };` (multiline version follows) |

> *Rule:* Always put the closing brace/parenthesis on a new line **unless** there’s only **one** key/value or array element between the brackets.

---

## 3️⃣ Semicolons

| Rule | Example |
|------|---------|
| **Mandatory** after every statement. | `let a = 1;` |
| **No code after the semicolon on the same line.** | ❌ `let a = 1; console.log(a);` **→** ✔ `let a = 1;` <br> `console.log(a);` |

---

## 4️⃣ Loops, Conditionals & Control Flow

| Construct | Placement | Example |
|-----------|-----------|---------|
| `if`/`else` | Opening `{` on a new line; closing `}` on a new line | ```js if (condition) { <br>     // do something <br> } <br> else { <br>     // do something else <br> } ``` |
| `for`, `while`, `do…while` | Same rule as `if` – braces start on a new line, close on a new line | ```js for (let i = 0; i < 10; i++) { <br>     doWork(i); <br> } ``` |
| `switch` | Opening brace on a new line; each `case` indented one level; closing brace on a new line | ```js switch (value) { <br>     case 1: <br>         doOne(); <br>         break; <br>     case 2: <br>         doTwo(); <br>         break; <br> } ``` |

---

## 5️⃣ Functions & Arrow Functions

| Body type | Placement | Example |
|-----------|-----------|---------|
| **Block body** (`{ … }`) | `{` starts on a new line; `}` ends on a new line | ```js const add = (a, b) => { <br>     const result = a + b; <br>     return result; <br> }; ``` |
| **Single‑expression** | Keep on one line *unless* the line exceeds 80 chars (then split into logical sub‑expressions). | `const double = x => x * 2;` |
| **Parameters** | Each parameter on its own line if more than one; opening parenthesis on the same line as the function name | ```js const compute = ( <br>     x, <br>     y <br> ) => { <br>     /* … */ <br> }; ``` |

---

## 6️⃣ Immediately‑Invoked Function Expression (IIFE)

```js
(
    () => {
        // …
    }
)();
```

---

## 7️⃣ Object Literals

### 7.1 Single‑key object

| Rule | Example |
|------|---------|
| **All on one line** (since only one item) | `const single = { key: value };` |

### 7.2 Multi‑key object

```js
const config = 
{
    mode: 'production',
    paths: 
    {
        src: './src',
        dist: './dist'
    },
    features: 
    {
        enabled: true,
        log: false,
    },
};
```

---

## 8️⃣ Arrays

| Context | Rule | Example |
|---------|------|---------|
| **Array with a single element** | All on one line | `const nums = [42];` |
| **Array with multiple elements** | Each element on its own line; opening `[` on its own line, closing `]` on its own line | ```js const arr = [ <br>     { a: 1 }, <br>     { b: 2 }, <br> ]; ``` |

---

## 9️⃣ Function Calls

| Context | Rule | Example |
|---------|------|---------|
| **Arguments after a comma** | Opening `{`/`[` must start on a new line | `doWork( a, b, { c: 3 } )` → the `{` after the comma starts on a new line |
| **Single argument** | Can stay on the same line | `log(value);` |
| **Multiple arguments** | Open brace after a comma starts on a new line; closing on its own line | ```js doWork( <br>     a, <br>     b, <br>     { <br>         c: 3, <br>     } <br> ); ``` |

---

## 🔒 Third‑Party Import Policy

| Step | Action | Acceptance Criteria |
|------|--------|---------------------|
| **1️⃣ Identify the need** | Before adding an import, answer: <br> • *Why is this library needed?* <br> • *What functionality would we implement ourselves?* | Document the answer in a short PR comment. |
| **2️⃣ Minimal footprint** | Use the library only for the *specific feature* that cannot be reasonably coded in plain JS. | Prefer native APIs (e.g., `fetch`, `URLSearchParams`, `Intl`, etc.). |
| **3️⃣ Source vetting** | Download the package source. Inspect for: <br> – Hard‑coded secrets <br> – External requests on load <br> – Obfuscated or minified code (flag for review) <br> – Known vulnerabilities (search NPM & GitHub advisories). | If any of the above is present, reject or request a fix. |
| **4️⃣ Security review** | Have a dedicated *Security Champion* (or the QA team) review the code. The champion must sign off on the *risk‑mitigation* checklist. | Checklist: <br> – Is the code free of hard‑coded keys? <br> – Does it make external network calls on load? <br> – Are there any polyfills that duplicate native behavior? |
| **5️⃣ Approve & lock** | Once approved, lock the package version to the exact commit hash or specific version. Record the approval in the repo’s `SECURITY_NOTES.md`. | Future changes to the package must trigger a new approval cycle. |
| **6️⃣ Monitor** | Add the package to `npm audit` / `snyk` (if used). If a CVE is reported, review immediately and consider a fallback to native code. | Continuous compliance is mandatory. |

> **Bottom line** – *Only import third‑party code when you can’t or don’t want to write the equivalent logic in vanilla JS. Every import must have a documented, approved reason that explicitly shows how it reduces cyber‑risk or breach potential.*

---

## 📄 Where to Find This

- `STYLE_GUIDE.md` – The coding style guide (above).  
- `THIRD_PARTY_POLICY.md` – The import policy (see section **🔒 Third‑Party Import Policy**).  
- `SECURITY_NOTES.md` – Record of all approved third‑party packages with their reasoning.

Add these files to the repository root and reference them in your README:

```markdown
## Code Standards

- Follow the **STYLE_GUIDE.md** for all formatting.
- Any third‑party import must be added to **THIRD_PARTY_POLICY.md** with an explicit justification and must be reviewed/approved by the Security Champion.

```

---

### 🎉 Summary

- **No TypeScript** – Pure vanilla JS only.  
- **Semicolons, braces, and commas** are strictly enforced as per the formatting rules.  
- **Third‑party code** is *only* allowed when *explicitly unavoidable* or *approved* after a risk review.  

Happy coding and stay secure!