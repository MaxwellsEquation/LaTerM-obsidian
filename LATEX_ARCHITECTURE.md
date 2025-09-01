# LaTeX Terminal Integration Architecture

## Current Terminal Architecture

### Current File Pipeline
```
main.ts (Plugin entry)
    ↓
load.ts (Register commands/views)
    ↓
spawn.ts (Create terminal instance)
    ↓
view.ts (Obsidian ItemView, UI management)
    ↓
emulator.ts (XtermTerminalEmulator wrapper)
    ↓
pseudoterminal.ts (Shell process connection)
    ↓
xterm.js (Terminal display with DOM/Canvas/WebGL)
```

### Current Data Flow
```
User Input → xterm.js → pseudoterminal → Shell Process
                ↑                             ↓
          Terminal Display ← pseudoterminal ← Shell Output
```

### Key Constraints
1. xterm.js uses a **fixed grid system** - each character occupies a cell
2. LaTeX equations have **variable dimensions** that don't fit the grid
3. Multi-line LaTeX **cannot displace** terminal text in the grid
4. Need to preserve **terminal functionality** (autocomplete, readline, etc.)

## Proposed Solution: Virtual Terminal Display

### New File Pipeline
```
main.ts (Plugin entry - unchanged)
    ↓
load.ts (Register commands/views - unchanged)
    ↓
spawn.ts (Create terminal instance - unchanged)
    ↓
view.ts (Obsidian ItemView - modified)
    ↓
virtual-display.ts (NEW - replaces emulator.ts)
    ├→ Input: xterm.js (DOM only, 1-3 lines)
    └→ Output: Custom HTML renderer
    ↓
pseudoterminal.ts (Shell process - unchanged)
```

### New Data Flow
```
User Input → Small xterm → VirtualDisplay → pseudoterminal → Shell
                                   ↓                            ↓
                            Parse & Route                 Shell Output
                                   ↓                            ↓
                          HTML Output Display ← Parse LaTeX ←──┘
```

### Architecture Decision
**Create a virtual terminal display** that separates input from output:
- **Input**: Small xterm.js terminal for command entry (with full terminal features)
- **Output**: Custom HTML-based display that can render LaTeX properly

### Why Virtual Terminal Display?
1. **True multi-line support**: LaTeX can render at natural size
2. **Preserves terminal features**: Autocomplete, readline work in input area
3. **Clean separation**: Input handling vs output rendering are independent
4. **No grid constraints**: Output area uses regular HTML/DOM
5. **Better UX**: Output can have rich formatting, clickable links, etc.

### Visual Architecture

```
┌────────────────────────────────────────┐
│       Virtual Terminal Container        │
│  ┌────────────────────────────────────┐ │
│  │    Virtual Output Display (95%)    │ │ ← Custom HTML renderer
│  │                                    │ │   Scrollable area
│  │  $ echo "Matrix $$\begin{bmatrix}  │ │   
│  │    1 & 2 \\ 3 & 4                  │ │
│  │    \end{bmatrix}$$"                │ │
│  │                                    │ │
│  │  Matrix [1 2]                      │ │ ← Rendered LaTeX
│  │         [3 4]                      │ │   (proper multi-line)
│  │                                    │ │
│  │  $ calculate.py                    │ │
│  │  Result: ∫x²dx = x³/3 + C         │ │
│  │                                    │ │
│  └────────────────────────────────────┘ │
│  ┌────────────────────────────────────┐ │
│  │  Input Terminal (xterm.js, 5%)    │ │ ← Real terminal
│  │  $ current_command█                │ │   (1-3 lines)
│  └────────────────────────────────────┘ │
└────────────────────────────────────────┘
```

### Key Architecture Changes

#### What Changes in Each File

**view.ts (Major Refactor)**
```typescript
// BEFORE:
class TerminalView {
    protected emulator: XtermTerminalEmulator
    
    startEmulator() {
        this.emulator = new XtermTerminalEmulator(...)
        // Single xterm for everything
    }
}

// AFTER:
class TerminalView {
    protected display: VirtualDisplay
    
    startTerminal() {
        this.display = new VirtualDisplay(...)
        // Split input/output system
    }
}
```

**virtual-display.ts (New File)**
```typescript
// Replaces emulator.ts functionality
export class VirtualDisplay {
    private inputTerminal: Terminal      // Small xterm (1-3 lines)
    private outputDisplay: HTMLDivElement // Custom HTML renderer
    private pty: Pseudoterminal          // Shell connection (from pseudoterminal.ts)
    
    constructor(container: HTMLElement, profile: Profile) {
        // Create split layout
        // Connect PTY
        // Route I/O appropriately
    }
}
```

**emulator.ts (Deprecated)**
```typescript
// This file becomes obsolete
// XtermTerminalEmulator no longer needed
// Functionality moved to VirtualDisplay
```

### Implementation Plan

#### Phase 1: Core Architecture
```typescript
// New file: src/terminal/virtual-display.ts
class VirtualTerminalDisplay {
    private container: HTMLElement;
    private outputDisplay: HTMLDivElement;
    private inputTerminal: Terminal;
    private outputBuffer: OutputLine[];
    private pty: IPseudoterminal;
    private ansiParser: AnsiParser;
    
    constructor(container: HTMLElement, profile: Profile) {
        this.setupLayout();
        this.connectPty(profile);
        this.setupEventHandlers();
    }
    
    private setupLayout() {
        // Create split container
        this.container.classList.add('virtual-terminal');
        
        // Output display area (95% height)
        this.outputDisplay = document.createElement('div');
        this.outputDisplay.className = 'virtual-output';
        this.container.appendChild(this.outputDisplay);
        
        // Input terminal area (5% height)
        const inputContainer = document.createElement('div');
        inputContainer.className = 'terminal-input';
        this.container.appendChild(inputContainer);
        
        // Small xterm for input only
        this.inputTerminal = new Terminal({
            rows: 1,
            cursorBlink: true,
            fontSize: 14
        });
        this.inputTerminal.open(inputContainer);
    }
}
```

#### Phase 2: PTY Connection and Routing
```typescript
interface OutputLine {
    type: 'text' | 'latex-inline' | 'latex-display' | 'mixed';
    content: string;
    raw: string;
    ansiCodes?: AnsiStyle;
    timestamp: number;
}

class VirtualTerminalDisplay {
    private connectPty(profile: Profile) {
        // Create PTY connection
        this.pty = createPseudoterminal(profile);
        
        // Route input from terminal to PTY
        this.inputTerminal.onData(data => {
            this.pty.write(data);
            this.handleInputEcho(data);
        });
        
        // Route output from PTY to virtual display
        this.pty.onData(data => {
            this.handlePtyOutput(data);
        });
    }
    
    private handlePtyOutput(data: string) {
        // Parse ANSI codes
        const parsed = this.ansiParser.parse(data);
        
        // Detect if this is a prompt
        if (this.isPrompt(parsed)) {
            this.handlePrompt(parsed);
            return;
        }
        
        // Add to output buffer
        this.processOutput(parsed);
        this.render();
    }
}
```

#### Phase 3: LaTeX Detection and Parsing
```typescript
const LATEX_PATTERNS = [
    { regex: /\$\$(.*?)\$\$/gs, type: 'display' },
    { regex: /\$(.*?)\$/g, type: 'inline' },
    { regex: /\\\[(.*?)\\\]/gs, type: 'display' },
    { regex: /\\\((.*?)\\\)/g, type: 'inline' },
    { regex: /\\begin\{(.*?)\}(.*?)\\end\{\1\}/gs, type: 'display' }
];

class LatexParser {
    parse(text: string): ParsedSegment[] {
        const segments: ParsedSegment[] = [];
        let lastIndex = 0;
        
        // Find all LaTeX patterns
        for (const pattern of LATEX_PATTERNS) {
            const matches = [...text.matchAll(pattern.regex)];
            for (const match of matches) {
                // Add text before match
                if (match.index > lastIndex) {
                    segments.push({
                        type: 'text',
                        content: text.slice(lastIndex, match.index)
                    });
                }
                
                // Add LaTeX
                segments.push({
                    type: 'latex',
                    content: match[1],
                    displayMode: pattern.type === 'display'
                });
                
                lastIndex = match.index + match[0].length;
            }
        }
        
        // Add remaining text
        if (lastIndex < text.length) {
            segments.push({
                type: 'text',
                content: text.slice(lastIndex)
            });
        }
        
        return segments;
    }
}
```

#### Phase 4: Rendering Engine
```typescript
import katex from 'katex';

class VirtualRenderer {
    render(buffer: OutputLine[], container: HTMLElement) {
        // Clear container
        container.innerHTML = '';
        
        for (const line of buffer) {
            const lineElement = this.createLineElement(line);
            container.appendChild(lineElement);
        }
        
        // Auto-scroll to bottom
        container.scrollTop = container.scrollHeight;
    }
    
    private createLineElement(line: OutputLine): HTMLElement {
        const div = document.createElement('div');
        div.className = 'output-line';
        
        switch (line.type) {
            case 'text':
                div.classList.add('text-line');
                this.renderText(line, div);
                break;
                
            case 'latex-display':
                div.classList.add('latex-display');
                this.renderLatex(line.content, div, true);
                break;
                
            case 'mixed':
                div.classList.add('mixed-line');
                this.renderMixed(line, div);
                break;
        }
        
        return div;
    }
    
    private renderLatex(latex: string, container: HTMLElement, display: boolean) {
        try {
            katex.render(latex, container, {
                displayMode: display,
                throwOnError: false,
                trust: true
            });
        } catch (e) {
            // Fallback to showing raw LaTeX
            container.textContent = display ? `$$${latex}$$` : `$${latex}$`;
            container.classList.add('latex-error');
        }
    }
}

```

#### Phase 5: CSS Structure
```css
.virtual-terminal {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--terminal-bg);
}

.virtual-output {
    flex: 1;
    overflow-y: auto;
    padding: 10px;
    font-family: 'Monaco', 'Menlo', monospace;
    font-size: 14px;
    line-height: 1.5;
}

.terminal-input {
    flex-shrink: 0;
    height: 30px;
    border-top: 1px solid var(--terminal-border);
    min-height: 30px;
    max-height: 90px; /* Can expand for multi-line input */
}

.output-line {
    white-space: pre-wrap;
    margin: 2px 0;
}

.latex-display {
    text-align: center;
    margin: 10px 0;
    padding: 10px;
    background: var(--latex-bg);
    border-radius: 4px;
}

.latex-inline {
    display: inline-block;
    vertical-align: middle;
    padding: 0 4px;
}

.latex-error {
    color: var(--error-color);
    font-family: monospace;
}

/* ANSI color classes */
.ansi-black { color: #000000; }
.ansi-red { color: #cc0000; }
.ansi-green { color: #4e9a06; }
.ansi-yellow { color: #c4a000; }
.ansi-blue { color: #3465a4; }
.ansi-magenta { color: #75507b; }
.ansi-cyan { color: #06989a; }
.ansi-white { color: #d3d7cf; }
```

### Integration Points

1. **PTY Creation**: Hook into existing pseudoterminal creation
2. **Profile Support**: Work with all terminal profiles (bash, zsh, etc.)
3. **Command Detection**: Identify prompts and separate input/output
4. **State Management**: Save/restore virtual display state
5. **Settings**: Toggle between virtual display and traditional terminal

### Prompt Detection Strategy

```typescript
class PromptDetector {
    private promptPatterns = [
        /\$\s*$/,           // Basic $ prompt
        />\s*$/,            // Basic > prompt
        /❯\s*$/,            // Fancy prompt
        /\]\$\s*$/,         // Bracketed prompt
        /\w+@\w+.*?\$\s*$/  // user@host prompt
    ];
    
    isPrompt(line: string): boolean {
        // Check if line ends with common prompt patterns
        return this.promptPatterns.some(p => p.test(line));
    }
    
    detectPromptBoundary(buffer: string): number {
        // Find where output ends and prompt begins
        const lines = buffer.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            if (this.isPrompt(lines[i])) {
                return i;
            }
        }
        return -1;
    }
}
```

### Handling Edge Cases

#### Interactive Programs (vim, less, htop)
```typescript
class VirtualTerminalDisplay {
    private isInteractiveMode = false;
    
    detectInteractiveProgram(data: string): boolean {
        // Check for alternate screen buffer activation
        if (data.includes('\x1b[?1049h')) {
            this.switchToFullTerminal();
            return true;
        }
        return false;
    }
    
    switchToFullTerminal() {
        // Hide virtual display, show full xterm
        this.outputDisplay.style.display = 'none';
        this.inputTerminal.resize(80, 24); // Full size
        this.isInteractiveMode = true;
    }
}
```

#### Copy/Paste Support
```typescript
class SelectionManager {
    getSelectedText(): string {
        const selection = window.getSelection();
        const text = selection.toString();
        
        // If LaTeX is selected, include source
        const latexElements = this.getSelectedLatexElements();
        if (latexElements.length > 0) {
            return this.reconstructLatexSource(text, latexElements);
        }
        
        return text;
    }
    
    reconstructLatexSource(text: string, elements: Element[]): string {
        // Replace rendered LaTeX with original source
        for (const elem of elements) {
            const source = elem.getAttribute('data-latex-source');
            if (source) {
                text = text.replace(elem.textContent, source);
            }
        }
        return text;
    }
}
```

### Theme Consistency

A critical concern is maintaining visual consistency between xterm.js and the virtual display. Users expect the virtual output to match their terminal theme exactly.

#### Theme Extraction and Synchronization

```typescript
class ThemeManager {
    private xtermTheme: ITheme;
    private cssVariables: Map<string, string> = new Map();
    
    extractTheme() {
        // Get theme from xterm
        const theme = this.terminal.options.theme || {};
        
        // Extract all colors
        this.cssVariables.set('--term-bg', theme.background || '#000000');
        this.cssVariables.set('--term-fg', theme.foreground || '#ffffff');
        this.cssVariables.set('--term-cursor', theme.cursor || '#ffffff');
        this.cssVariables.set('--term-selection', theme.selection || '#4d4d4d');
        
        // ANSI colors (0-15)
        this.cssVariables.set('--term-black', theme.black || '#000000');
        this.cssVariables.set('--term-red', theme.red || '#cc0000');
        this.cssVariables.set('--term-green', theme.green || '#4e9a06');
        this.cssVariables.set('--term-yellow', theme.yellow || '#c4a000');
        this.cssVariables.set('--term-blue', theme.blue || '#3465a4');
        this.cssVariables.set('--term-magenta', theme.magenta || '#75507b');
        this.cssVariables.set('--term-cyan', theme.cyan || '#06989a');
        this.cssVariables.set('--term-white', theme.white || '#d3d7cf');
        // ... plus bright variants
        
        // Extract font metrics from rendered terminal
        this.extractComputedStyles();
    }
    
    extractComputedStyles() {
        const termElement = this.terminal.element;
        const computed = window.getComputedStyle(termElement);
        
        // Font settings must match exactly
        this.cssVariables.set('--term-font-family', computed.fontFamily);
        this.cssVariables.set('--term-font-size', computed.fontSize);
        this.cssVariables.set('--term-line-height', computed.lineHeight);
        this.cssVariables.set('--term-letter-spacing', computed.letterSpacing);
    }
    
    applyToVirtualDisplay(container: HTMLElement) {
        // Apply all CSS variables to virtual display
        for (const [key, value] of this.cssVariables) {
            container.style.setProperty(key, value);
        }
    }
}
```

#### CSS Variable Sharing

```css
/* Virtual display inherits terminal theme */
.virtual-output {
    /* Colors from xterm */
    background: var(--term-bg);
    color: var(--term-fg);
    
    /* Font must match exactly */
    font-family: var(--term-font-family);
    font-size: var(--term-font-size);
    line-height: var(--term-line-height);
    letter-spacing: var(--term-letter-spacing);
    
    /* Consistent rendering */
    -webkit-font-smoothing: antialiased;
    font-variant-ligatures: normal;
}

/* ANSI colors use CSS variables */
.ansi-black { color: var(--term-black); }
.ansi-red { color: var(--term-red); }
/* ... all 16 colors */

/* LaTeX with subtle differentiation */
.latex-display {
    /* Slightly lighter/darker than terminal bg */
    background: color-mix(in srgb, var(--term-bg) 95%, var(--term-fg) 5%);
    color: var(--term-fg);
    
    /* Override KaTeX colors */
    --katex-text-color: var(--term-fg);
    --katex-math-color: var(--term-fg);
}
```

#### Obsidian Theme Integration

```typescript
class ObsidianThemeSync {
    syncWithObsidian() {
        const isDarkTheme = document.body.classList.contains('theme-dark');
        
        if (this.settings.theme === 'auto') {
            // Use Obsidian's theme colors
            const root = document.documentElement;
            const obsidianBg = getComputedStyle(root)
                .getPropertyValue('--background-primary');
            const obsidianFg = getComputedStyle(root)
                .getPropertyValue('--text-normal');
            
            // Fallback to Obsidian colors if no terminal theme
            this.cssVariables.set('--term-bg', this.xtermTheme.background || obsidianBg);
            this.cssVariables.set('--term-fg', this.xtermTheme.foreground || obsidianFg);
        }
    }
}
```

#### Font Metric Consistency

```typescript
class FontMetrics {
    ensureCharacterAlignment() {
        // Measure character dimensions in both displays
        const measureChar = (element: HTMLElement): {width: number, height: number} => {
            const span = document.createElement('span');
            span.textContent = 'M';
            span.style.position = 'absolute';
            span.style.visibility = 'hidden';
            element.appendChild(span);
            const metrics = {
                width: span.offsetWidth,
                height: span.offsetHeight
            };
            element.removeChild(span);
            return metrics;
        };
        
        const termMetrics = measureChar(this.inputTerminal.element);
        const displayMetrics = measureChar(this.outputDisplay);
        
        // Adjust if mismatched
        if (Math.abs(termMetrics.width - displayMetrics.width) > 0.5) {
            // Adjust font-size or letter-spacing
            this.adjustFontMetrics(termMetrics, displayMetrics);
        }
    }
}
```

### Settings Integration
```typescript
interface LaTeXSettings {
    enabled: boolean;
    renderMode: 'virtual' | 'overlay' | 'disabled';
    patterns: string[];  // Custom LaTeX patterns
    renderer: 'katex' | 'mathjax';
    theme: 'auto' | 'custom' | 'dracula' | 'monokai' | 'solarized';
    customTheme?: ITheme;  // Custom color scheme
    syncWithObsidian: boolean;  // Follow Obsidian's dark/light mode
    scale: number;  // Font size multiplier
    maxOutputLines: number;  // Buffer limit
    preserveHistory: boolean;
}
```

## File Change Summary

### Files to Modify

| File | Changes Required | Impact |
|------|-----------------|---------|
| **view.ts** | Replace XtermTerminalEmulator with VirtualDisplay | Major refactor |
| **emulator-addons.ts** | Remove RendererAddon class entirely | Delete ~60 lines |
| **settings-data.ts** | Remove renderer preferences, add LaTeX settings | Minor changes |
| **styles.css** | Add virtual display styling | Add ~100 lines |

### Files to Create

| File | Purpose | Size |
|------|---------|------|
| **virtual-display.ts** | Main virtual terminal implementation | ~600 lines |
| **ansi-parser.ts** | Parse ANSI escape sequences | ~200 lines |
| **latex-renderer.ts** | LaTeX detection and rendering | ~300 lines |
| **prompt-detector.ts** | Detect shell prompts | ~100 lines |

### Files Unchanged

| File | Why Unchanged |
|------|--------------|
| **main.ts** | Plugin initialization stays same |
| **load.ts** | Command registration stays same |
| **spawn.ts** | Terminal spawning logic stays same |
| **pseudoterminal.ts** | Shell connection layer works as-is |
| **profile-properties.ts** | Profile management unchanged |

### Removed Dependencies

```typescript
// No longer needed in package.json:
- "@xterm/addon-canvas"
- "@xterm/addon-webgl"
- "@xterm/addon-fit"  // Causes resize bugs

// Keep these:
+ "@xterm/xterm"  // Still used for input terminal
+ "@xterm/addon-search"  // Might adapt for virtual display
+ "@xterm/addon-serialize"  // For state saving
```

### New Dependencies

```typescript
// Add to package.json:
+ "katex": "^0.16.0"  // LaTeX rendering
+ "@types/katex": "^0.16.0"
+ "ansi-to-html": "^0.7.0"  // ANSI parsing helper (optional)
```

## Implementation Phases

### Phase 1: Core Infrastructure (Week 1)
- Create `virtual-display.ts` with basic structure
- Set up split input/output layout
- Connect PTY to virtual display
- Basic text rendering (no ANSI/LaTeX yet)

### Phase 2: Terminal Features (Week 2)
- Implement ANSI color parsing
- Add prompt detection
- Handle interactive program switching
- Implement scrollback buffer

### Phase 3: LaTeX Integration (Week 3)
- Add LaTeX pattern detection
- Integrate KaTeX rendering
- Handle inline vs display math
- Implement theme consistency

### Phase 4: Polish & Migration (Week 4)
- Update Find functionality
- Add settings UI
- Create migration path from old terminals
- Testing and bug fixes

## Performance Considerations

1. **Virtual scrolling**: Only render visible output lines
2. **Debounced rendering**: Batch rapid output updates
3. **LaTeX caching**: Cache rendered equations by content hash
4. **Memory management**: Limit output buffer size
5. **Lazy KaTeX loading**: Load only when LaTeX is detected

## Testing Strategy

1. **Unit tests**: Parser, prompt detection, ANSI handling
2. **Integration tests**: PTY connection, input/output routing
3. **Visual tests**: LaTeX rendering, layout, scrolling
4. **Performance tests**: Large output, rapid updates
5. **Compatibility tests**: Different shells, terminal programs

## Advantages Over Alternatives

| Feature | Virtual Display | Overlay | Grid Modification |
|---------|----------------|---------|-------------------|
| Multi-line LaTeX | ✅ Perfect | ❌ Overlaps | ❌ Breaks grid |
| Terminal features | ✅ Preserved | ✅ Preserved | ⚠️ Partially broken |
| Performance | ✅ Good | ✅ Good | ❌ Poor |
| Complexity | 🟡 Moderate | 🟢 Low | 🔴 High |
| Maintenance | ✅ Easy | ✅ Easy | ❌ Hard |
| User Experience | ✅ Best | 🟡 OK | ❌ Poor |