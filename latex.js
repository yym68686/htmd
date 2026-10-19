// 处理数学公式和 Markdown 的函数
let markedConfigured = false;
let mermaidRenderScheduled = false;

// 流式输出时，同一条消息会被反复整体重新解析：每 100ms 一次，且每次都要重新高亮
// 全部代码块。下面的缓存让已经高亮过的代码块直接复用结果，把重复代价降为一次哈希查表。
const HIGHLIGHT_CACHE_LIMIT = 400;
const highlightCache = new Map();

// hljs.highlightAuto 会尝试全部已注册语言（打包版 36 种），实测单块 ~1.1ms，比指定语言
// 慢一个数量级；而 LLM 经常不写语言标签，所以这条路径是常态。
//
// 这里只做缓存、不收窄候选语言：实测 40 次重解析 268ms -> 6ms（缓存），再加语言子集只
// 到 4ms，但子集会让 lua / perl / dockerfile / r 等识别错误。省 2ms 不值得换识别质量。
function highlightCode(code, lang) {
    const key = `${lang || ''}\u0000${code}`;
    const cached = highlightCache.get(key);
    if (cached !== undefined) return cached;

    let result;
    if (lang && hljs.getLanguage(lang)) {
        try {
            result = hljs.highlight(code, { language: lang }).value;
        } catch (err) {
            console.error('代码高亮错误:', err);
        }
    }
    if (result === undefined) {
        try {
            result = hljs.highlightAuto(code).value;
        } catch (err) {
            console.error('代码高亮错误:', err);
            result = escapeHtmlForCode(code);
        }
    }

    if (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT) {
        // 流式输出会为同一个代码块的每个中间态各留一条记录，这里粗粒度清掉最老的一批，
        // 避免长会话下无界增长。
        const staleKeys = [];
        for (const existingKey of highlightCache.keys()) {
            staleKeys.push(existingKey);
            if (staleKeys.length >= HIGHLIGHT_CACHE_LIMIT / 2) break;
        }
        staleKeys.forEach((staleKey) => highlightCache.delete(staleKey));
    }
    highlightCache.set(key, result);
    return result;
}

function escapeHtmlForCode(code) {
    return String(code)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// 围栏闭合正则只取决于围栏字符和长度，组合极少；缓存掉可以省掉流式重解析时的重复编译。
const fenceCloseRegexCache = new Map();

function getFenceCloseRegex(fenceChar, fenceLen) {
    const key = `${fenceChar}${fenceLen}`;
    let re = fenceCloseRegexCache.get(key);
    if (!re) {
        re = new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}(?:\\s|$)`);
        fenceCloseRegexCache.set(key, re);
    }
    return re;
}

// index.html 原先用同步 <script> 加载 marked(35KB) + highlight(119KB) + mermaid(2.9MB)，
// 三者都会阻塞应用入口。mermaid 尤其夸张：绝大多数会话根本没有图表，却每次打开侧栏都要
// 解析 2.9MB。这里改成按需加载，各自只在第一次真正需要时才注入 <script>。
const scriptPromises = new Map();

// 必须按公开资源根目录解析，不能用 import.meta.url：打包后这个模块在 v/<version>/ 下，
// 而 htmd/ 是原样复制到产物根目录的。这里复刻 src/platform/assets.js 的 appAssetUrl —
// 本文件属于 htmd 子模块，不能反向 import 主仓库代码。
function assetUrl(file) {
    const path = `htmd/${file}`;
    // getManifest 只有扩展页面拿得到：普通网页在装了 externally_connectable 扩展时也会有
    // chrome.runtime，但只有 sendMessage/connect，所以两个方法都要判断。
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL && chrome.runtime?.getManifest) {
        const manifest = chrome.runtime.getManifest();
        const entry = manifest.background?.service_worker || manifest.background?.scripts?.[0] || '';
        const directory = entry.slice(0, entry.lastIndexOf('/') + 1);
        return chrome.runtime.getURL(`${directory}${path}`);
    }
    return new URL(path, document.baseURI).href;
}

function loadScriptOnce(file, id) {
    let promise = scriptPromises.get(file);
    if (promise) return promise;
    promise = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-cerebr-asset="${CSS.escape(file)}"]`);
        if (existing) {
            if (existing.dataset.cerebrLoaded === '1') {
                resolve();
                return;
            }
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${file}`)), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = assetUrl(file);
        script.async = false;
        // MathJax 的启动代码要靠 document.getElementById('MathJax-script') 找到自己，
        // 从而推导字体等资源路径，所以这个 id 必须保留。
        if (id) script.id = id;
        script.dataset.cerebrAsset = file;
        script.addEventListener(
            'load',
            () => {
                script.dataset.cerebrLoaded = '1';
                resolve();
            },
            { once: true }
        );
        script.addEventListener('error', () => reject(new Error(`Failed to load ${file}`)), { once: true });
        document.head.appendChild(script);
    });
    scriptPromises.set(file, promise);
    return promise;
}

// marked / highlight.js 是同步渲染路径上的依赖，没法等 Promise。所以首次渲染前先由
// ensureMarkdownReady() 预热，processMathAndMarkdown 里只做存在性判断。
export function ensureMarkdownReady() {
    return Promise.all([
        window.marked ? null : loadScriptOnce('marked.min.js'),
        window.hljs ? null : loadScriptOnce('highlight.min.js'),
    ]);
}

export function isMarkdownReady() {
    return !!(window.marked && window.hljs);
}

let mermaidLoading = null;

function ensureMermaidReady() {
    if (window.mermaid && window.initializeCerebrMermaid) {
        return Promise.resolve();
    }
    if (!mermaidLoading) {
        // mermaid-init.js 依赖 window.mermaid 已存在，必须按顺序加载。
        mermaidLoading = loadScriptOnce('mermaid.min.js')
            .then(() => loadScriptOnce('mermaid-init.js'))
            .then(() => {
                window.initializeCerebrMermaid?.();
            })
            .catch((error) => {
                mermaidLoading = null;
                throw error;
            });
    }
    return mermaidLoading;
}

function scheduleMermaidRender() {
    if (mermaidRenderScheduled) return;
    mermaidRenderScheduled = true;
    const run = () => {
        mermaidRenderScheduled = false;
        ensureMermaidReady()
            .then(() => {
                if (window.renderMermaidDiagrams) {
                    window.renderMermaidDiagrams();
                }
            })
            .catch((error) => console.error('Mermaid 加载失败:', error));
    };
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(run, { timeout: 300 });
    } else {
        setTimeout(run, 0);
    }
}

// 供 React 侧在确认 HTML 里有 mermaid 容器后调用。
export function requestMermaidRender() {
    scheduleMermaidRender();
}

let mathJaxLoading = null;

function ensureMathJaxReady() {
    if (window.MathJax?.typesetPromise) return Promise.resolve();
    if (!mathJaxLoading) {
        // mathjax-config.js 必须在 tex-chtml-full.js 之前执行（它设置 window.MathJax 配置）。
        mathJaxLoading = loadScriptOnce('mathjax-config.js')
            .then(() => loadScriptOnce('tex-chtml-full.js', 'MathJax-script'))
            .then(() => window.MathJax?.startup?.promise)
            .catch((error) => {
                mathJaxLoading = null;
                throw error;
            });
    }
    return mathJaxLoading;
}

function isEscapedByBackslash(str, index) {
    let backslashCount = 0;
    for (let i = index - 1; i >= 0 && str[i] === '\\'; i--) {
        backslashCount++;
    }
    return (backslashCount % 2) === 1;
}

function isAsciiWordChar(ch) {
    return !!ch && /[A-Za-z0-9_]/.test(ch);
}

function isWhitespaceChar(ch) {
    return !!ch && /\s/.test(ch);
}

function isSingleDollarDelimiter(str, index) {
    if (str[index] !== '$') return false;
    if (isEscapedByBackslash(str, index)) return false;
    if (str[index - 1] === '$' || str[index + 1] === '$') return false;
    return true;
}

function isLikelyInlineDollarMath(content, beforeOpen, afterOpen, beforeClose, afterClose) {
    if (!content) return false;
    if (!afterOpen || isWhitespaceChar(afterOpen)) return false;
    if (beforeOpen && isAsciiWordChar(beforeOpen)) return false;
    if (!beforeClose || isWhitespaceChar(beforeClose)) return false;
    if (afterClose && isAsciiWordChar(afterClose)) return false;

    const isNumber = /^[+-]?\d[\d,]*(?:\.\d+)?$/.test(content);
    if (/^[A-Z][A-Z0-9]{1,14}$/.test(content)) return false;
    if (/^[A-Z0-9]{2,15}(?:[\\/\\-][A-Z0-9]{2,15})+$/.test(content)) return false;

    const hasTeXCommand = /\\[A-Za-z]/.test(content);
    const hasLowercase = /[a-z]/.test(content);
    const isSingleUppercaseLetter = /^[A-Z]$/.test(content);
    const hasDigitsAndLetters = /\d/.test(content) && /[A-Za-z]/.test(content);
    const hasMathOperators = /[=<>^_{}+\-*/|()[\]:]/.test(content);

    if (/\s/.test(content) && !hasTeXCommand && !hasMathOperators) return false;
    return hasTeXCommand || hasLowercase || isSingleUppercaseLetter || hasDigitsAndLetters || hasMathOperators || isNumber;
}

function findClosingDollarInLine(line, startIndex) {
    let inCode = false;
    let codeDelimiterLen = 0;

    for (let i = startIndex; i < line.length; i++) {
        const ch = line[i];
        if (ch === '`') {
            let j = i;
            while (j < line.length && line[j] === '`') j++;
            const tickLen = j - i;
            if (!inCode) {
                inCode = true;
                codeDelimiterLen = tickLen;
            } else if (tickLen === codeDelimiterLen) {
                inCode = false;
                codeDelimiterLen = 0;
            }
            i = j - 1;
            continue;
        }

        if (!inCode && ch === '$' && isSingleDollarDelimiter(line, i)) {
            return i;
        }
    }

    return -1;
}

function convertInlineDollarMathToParensInLine(line) {
    let out = '';
    let inCode = false;
    let codeDelimiterLen = 0;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];

        if (ch === '`') {
            let j = i;
            while (j < line.length && line[j] === '`') j++;
            const tickLen = j - i;
            if (!inCode) {
                inCode = true;
                codeDelimiterLen = tickLen;
            } else if (tickLen === codeDelimiterLen) {
                inCode = false;
                codeDelimiterLen = 0;
            }
            out += line.slice(i, j);
            i = j - 1;
            continue;
        }

        if (!inCode && ch === '$' && isSingleDollarDelimiter(line, i)) {
            const closeIndex = findClosingDollarInLine(line, i + 1);
            if (closeIndex !== -1) {
                const content = line.slice(i + 1, closeIndex);
                const beforeOpen = i > 0 ? line[i - 1] : '';
                const afterOpen = line[i + 1] ?? '';
                const beforeClose = closeIndex > 0 ? line[closeIndex - 1] : '';
                const afterClose = line[closeIndex + 1] ?? '';

                if (isLikelyInlineDollarMath(content, beforeOpen, afterOpen, beforeClose, afterClose)) {
                    out += `\\(${content}\\)`;
                    i = closeIndex;
                    continue;
                }
            }
        }

        out += ch;
    }

    return out;
}

function convertInlineDollarMathToParens(text) {
    const str = String(text ?? '');
    if (!str) return str;

    const lines = str.split('\n');
    const outLines = [];

    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;
    let fenceCloseRe = null;

    for (const line of lines) {
        if (inFence) {
            if (fenceCloseRe && fenceCloseRe.test(line)) {
                inFence = false;
                fenceChar = '';
                fenceLen = 0;
                fenceCloseRe = null;
            }
            outLines.push(line);
            continue;
        }

        const fenceOpen = line.match(/^ {0,3}(```+|~~~+)/);
        if (fenceOpen) {
            const fence = fenceOpen[1];
            fenceChar = fence[0];
            fenceLen = fence.length;
            fenceCloseRe = getFenceCloseRegex(fenceChar, fenceLen);
            inFence = true;
            outLines.push(line);
            continue;
        }

        outLines.push(convertInlineDollarMathToParensInLine(line));
    }

    return outLines.join('\n');
}

function textMayContainInlineDollarMath(text) {
    const str = String(text ?? '');
    if (!str) return false;

    const lines = str.split('\n');

    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;
    let fenceCloseRe = null;

    for (const line of lines) {
        if (inFence) {
            if (fenceCloseRe && fenceCloseRe.test(line)) {
                inFence = false;
                fenceChar = '';
                fenceLen = 0;
                fenceCloseRe = null;
            }
            continue;
        }

        const fenceOpen = line.match(/^ {0,3}(```+|~~~+)/);
        if (fenceOpen) {
            const fence = fenceOpen[1];
            fenceChar = fence[0];
            fenceLen = fence.length;
            fenceCloseRe = getFenceCloseRegex(fenceChar, fenceLen);
            inFence = true;
            continue;
        }

        let inCode = false;
        let codeDelimiterLen = 0;

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '`') {
                let j = i;
                while (j < line.length && line[j] === '`') j++;
                const tickLen = j - i;
                if (!inCode) {
                    inCode = true;
                    codeDelimiterLen = tickLen;
                } else if (tickLen === codeDelimiterLen) {
                    inCode = false;
                    codeDelimiterLen = 0;
                }
                i = j - 1;
                continue;
            }

            if (!inCode && ch === '$' && isSingleDollarDelimiter(line, i)) {
                const closeIndex = findClosingDollarInLine(line, i + 1);
                if (closeIndex === -1) continue;

                const content = line.slice(i + 1, closeIndex);
                const beforeOpen = i > 0 ? line[i - 1] : '';
                const afterOpen = line[i + 1] ?? '';
                const beforeClose = closeIndex > 0 ? line[closeIndex - 1] : '';
                const afterClose = line[closeIndex + 1] ?? '';

                if (isLikelyInlineDollarMath(content, beforeOpen, afterOpen, beforeClose, afterClose)) {
                    return true;
                }
            }
        }
    }

    return false;
}

export function textMayContainMath(text) {
    if (!text) return false;
    const str = String(text);
    if (/(\\\(|\\\[|\$\$|\\begin\{|\\boxed\{)/.test(str)) return true;
    return textMayContainInlineDollarMath(str);
}
// \mathds 字符映射（提到模块作用域，避免每次解析都重建对象）
const MATHDS_MAP = {
    'A': '𝔸', 'B': '𝔹', 'C': 'ℂ', 'D': '𝔻', 'E': '𝔼',
    'F': '𝔽', 'G': '𝔾', 'H': 'ℍ', 'I': '𝕀', 'J': '𝕁',
    'K': '𝕂', 'L': '𝕃', 'M': '𝕄', 'N': 'ℕ', 'O': '𝕆',
    'P': 'ℙ', 'Q': 'ℚ', 'R': 'ℝ', 'S': '𝕊', 'T': '𝕋',
    'U': '𝕌', 'V': '𝕍', 'W': '𝕎', 'X': '𝕏', 'Y': '𝕐',
    'Z': 'ℤ',
    '0': '𝟘', '1': '𝟙', '2': '𝟚', '3': '𝟛', '4': '𝟜',
    '5': '𝟝', '6': '𝟞', '7': '𝟟', '8': '𝟠', '9': '𝟡'
};

// 各条规则都先用 indexOf 判断关键字面量再跑正则：indexOf 是线性扫描且常数极小，
// 而这些规则在一条消息里通常只有一两条会命中。
function normalizeLatexSyntax(text) {
    text = text.replace(/\\\[([a-zA-Z\d]+)\]/g, '[$1]');

    if (text.indexOf('\\mathds{') !== -1) {
        text = text.replace(/\\mathds\{([A-Z0-9])\}/g, (match, char) => {
            return MATHDS_MAP[char] || match;
        });
    }

    if (text.indexOf('\\begin{align*}') !== -1) {
        text = text.replace(/^\s*\\begin\{align\*\}/gm, '\\[\n\\begin{align*}');
    }
    if (text.indexOf('\\end{align*}') !== -1) {
        text = text.replace(/\\end\{align\*\}\s*$/gm, '\\end{align*}\n\\]');
    }

    if (text.indexOf('\\label{eq:') !== -1) {
        text = text.replace(/\\label{eq:.*?}/gm, '');
    }

    if (text.indexOf('\\begin{equation}') !== -1) {
        text = text.replace(/^\s*\\begin\{equation\}/gm, '\\[\n\\begin{equation}');
    }
    if (text.indexOf('\\end{equation}') !== -1) {
        text = text.replace(/\\end\{equation\}\s*$/gm, '\\end{equation}\n\\]');
    }

    // 处理 \boxed 命令，将其包装在 \[ \] 中
    // 这里的 [\s\S]+ 必须保持贪婪：\boxed{\frac{1}{2}} 这类嵌套花括号要靠贪婪匹配才能
    // 吃到最外层的 }，改成惰性会截断在第一个 } 上。
    if (text.indexOf('\\boxed{') !== -1) {
        text = text.replace(/(\\\[\s*)?\$*\\boxed\{([\s\S]+)\}\$*(\s*\\\])?/g, '\\[\\boxed{$2}\\]');
    }

    if (text.indexOf('\\textsc{') !== -1) {
        text = text.replace(/\\textsc\{([^}]+)\}/g, (match, content) => {
            return content.toUpperCase();
        });
    }

    return text;
}

export function processMathAndMarkdown(text) {
    const mathExpressions = [];
    const imageExpressions = [];
    let mathIndex = 0;
    let imageIndex = 0;

    // 预处理，提取图片标签
    text = text.replace(/<span class="image-tag".*?<\/span>/g, (match) => {
        const placeholder = `%%IMAGE_EXPRESSION_${imageIndex}%%`;
        imageExpressions.push(match);
        imageIndex++;
        return placeholder;
    });

    // 这一段全是 LaTeX 专用的规范化，纯文本消息一条都不会命中。流式输出时整条消息每
    // 100ms 会被重新处理一遍，所以先用一次廉价探测决定是否要走这十几条正则。
    if (text.indexOf('\\') !== -1) {
        text = normalizeLatexSyntax(text);
    }

    text = text.replace(/^---\n$/gm, '');

    // 处理 think 标签，将其转换为引用格式
    if (text.indexOf('<think>') !== -1) {
        // 首先处理完整的 <think>...</think> 标签
        text = text.replace(/<think>([\s\S]*?)<\/think>/g, (match, content) => {
            // 处理多行文本，为每一行添加引用符号
            return content.trim().split('\n').map(line => `> ${line.trim()}`).join('\n');
        });

        // 然后处理只有开始标签的情况
        text = text.replace(/<think>\n?([\s\S]*?)(?=<\/think>|$)/g, (match, content) => {
            if (!match.includes('</think>')) {
                // 如果没有结束标签，将所有后续内容都转换为引用格式
                return content.trim().split('\n').map(line => `> ${line.trim()}`).join('\n');
            }
            return match; // 如果有结束标签，保持原样（因为已经在上一步处理过了）
        });
    }

    if (text.indexOf('%') !== -1) {
        text = text.replace(/%\n\s*/g, ''); // 移除换行的百分号
    }
    if (text.indexOf('（') !== -1) {
        text = text.replace(/（\\\((.+?)\\）/g, '（\\($1\\)）');
    }

    text = convertInlineDollarMathToParens(text);
    // 临时替换数学公式（支持 \(..\)、\[..\]、$$..$$ 以及单行内联 $..$）
    text = text.replace(/(\\\\\([^]+?\\\\\))|(\\\([^]+?\\\))|(\\\[[\s\S]+?\\\])|(\$\$[\s\S]+?\$\$)/g, (match) => {
        // 处理除号
        match = match.replace(/\\div\b/g, ' ÷ ');
        match = match.replace(/\\\[\s*(.+?)\s*\\+\]/g, '\\[ $1 \\]');
        match = match.replace(/\\\(\s*(.+?)\s*\\）/g, '\\( $1 \\)');
        match = match.replace(/\\\(\s*(.+?)\s*\\，/g, '\\( $1 \\)，');
        match = match.replace(/</g, '&lt;');
        match = match.replace(/>/g, '&gt;');
        match = match.replace(/%\s/g, '');

        // 处理 \bm 命令，将其替换为 \boldsymbol 粗体向量
        match = match.replace(/\\bm\{([^{}]+)\}/g, '\\boldsymbol{$1}');
        match = match.replace(/\\bm\s*(\\[A-Za-z]+|[A-Za-z0-9])/g, '\\boldsymbol{$1}');

        // 处理 \coloneqq 命令（避免依赖额外 TeX 包）
        match = match.replace(/\\coloneqq\b/g, '\\mathrel{:=}');

        // 如果是普通括号形式公式，转换为 \(...\) 形式
        if (match.startsWith('(') && match.endsWith(')') && !match.startsWith('\\(')) {
            console.log('警告：请使用 \\(...\\) 来表示行内公式');
        }

        // 为行间公式添加容器
        if (match.startsWith('\\[') || match.startsWith('$$')) {
            match = `<div class="math-display-container">${match}</div>`;
        }

        const placeholder = `%%MATH_EXPRESSION_${mathIndex}%%`;
        mathExpressions.push(match);
        mathIndex++;
        return placeholder;
    });

    // 配置 marked（只初始化一次）
    if (!markedConfigured) {
        const hanChar = /\p{Script=Han}/u;
        const strongEnd = marked.Lexer.rules.inline.gfm.emStrongRDelimAst;
        // 沿用 marked 的定界符配对规则，只补充“标点 + ** + 汉字”的闭合边界。
        // 不给原文补空格，避免改变代码、链接地址、转义内容和用户原有的排版。
        const chineseStrongEnd = new RegExp(
            strongEnd.source.replace('(?=[\\s]|$)', '(?=[\\s\\p{Script=Han}]|$)'),
            strongEnd.flags
        );
        marked.setOptions({
            breaks: true,
            gfm: true,
            sanitize: false,
            tokenizer: Object.assign(new marked.Tokenizer(), {
                emStrong(src, maskedSrc, prevChar = '') {
                    if (!src.startsWith('**')) {
                        return marked.Tokenizer.prototype.emStrong.call(this, src, maskedSrc, prevChar);
                    }
                    // 汉字后紧邻引号/括号的 ** 也可开头，例如：手机的**“省电模式”**。
                    // maskedSrc 仍由 marked 提供，保留对代码、链接、转义和嵌套强调的处理。
                    const context = Object.create(this);
                    context.rules = {
                        ...this.rules,
                        inline: { ...this.rules.inline, emStrongRDelimAst: chineseStrongEnd }
                    };
                    return marked.Tokenizer.prototype.emStrong.call(
                        context, src, maskedSrc, hanChar.test(prevChar) ? '' : prevChar
                    );
                },
                del(src) {
                    // 单个 ~ 常用于数字范围（2~3 次、15~30ms），不能跨范围配成删除线。
                    // 只允许明确的 ~~文字~~；其余语法继续使用 marked 的原生解析。
                    if (!src.startsWith('~~')) return;
                    return marked.Tokenizer.prototype.del.call(this, src);
                }
            }),
            highlight: function(code, lang) {
                if (lang === 'mermaid') {
                    return `<div class="mermaid">${code}</div>`;
                }
                return highlightCode(code, lang);
            },
            renderer: Object.assign(new marked.Renderer(), {
                // 直接在生成 HTML 时就写上 target/rel，省掉渲染后再 querySelectorAll('a')
                // 遍历整棵子树改属性（流式下每 100ms 一次）。
                link(href, title, text) {
                    const base = marked.Renderer.prototype.link.call(this, href, title, text);
                    if (!base.startsWith('<a ')) return base;
                    return base.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
                },
                code(code, language) {
                    // 检查是否包含数学表达式占位符
                    if (code.includes('%%MATH_EXPRESSION_')) {
                        return code;  // 如果包含数学表达式，直接返回原文本
                    }
                    if (language === 'mermaid') {
                        return `<div class="mermaid">${code}</div>`;
                    }
                    const validLanguage = language && hljs.getLanguage(language) ? language : '';
                    const highlighted = this.options.highlight(code, validLanguage);
                    return `<pre data-language="${validLanguage || 'plaintext'}"><code>${highlighted}</code></pre>`;
                },
                listitem(text) {
                    // 保持列表项的原始格式
                    return `<li>${text}</li>\n`;
                }
            })
        });
        markedConfigured = true;
    }

    // console.log(text);
/*
完整复述下面的字符包括换行：
为 **Xmodel-2** 的针对**推理任务**进行
**第一封邮件（7月22日）**是
即 **a** ⊗ **b** ≠ **b** ⊗ **a**。
**1. 主要贡献:**
**2. A 和 B 矩阵的生成**
*   **开源:** Xmodel-2 是开源的
*   **OLMo 2-13B**：上下文长度为 **4096 个 token**。
*/

    // // 处理第一级列表（确保使用3个空格）
    // text = text.replace(/^ {3,4}\*\s+/mg, '    * ');

    // // 处理列表缩进，保持层级关系但使用4个空格
    // text = text.replace(/^( {4,})\*(\s+)/mg, (match, spaces, trailing) => {
    //     // 找出所有列表项的最小缩进空格数
    //     const minIndent = Math.min(...text.match(/^( *)\*/mg).map(s => s.length - 1));
    //     // 计算当前项相对于最小缩进的层级（每4个空格算一级）
    //     const relativeLevel = Math.floor((spaces.length - minIndent) / 4);
    //     // 根据最小缩进确定最大允许层级
    //     const maxLevel = minIndent === 0 ? 2 : (minIndent === 4 ? 3 : 4);
    //     // 限制最终层级
    //     const level = Math.min(relativeLevel, maxLevel - Math.floor(minIndent / 4));
    //     // 为每一级添加4个空格
    //     return '    '.repeat(level) + '* ';
    // });

    // console.log(text);

    // 渲染 Markdown
    let html = marked.parse(text);

    // 恢复数学公式
    html = html.replace(/%%MATH_EXPRESSION_(\d+)%%/g, (_, index) => {
        return mathExpressions[index];
    });

    // 恢复图片
    html = html.replace(/%%IMAGE_EXPRESSION_(\d+)%%/g, (_, index) => {
        return imageExpressions[index];
    });

    // 移除数学公式容器外的 p 标签
    html = html.replace(/<p>\s*(<div class="math-display-container">[\s\S]*?<\/div>)\s*<\/p>/g, '$1');

    // 仅在确实包含 Mermaid 图表时再调度渲染，避免每次消息都触发
    if (/class=["']mermaid["']/.test(html)) {
        scheduleMermaidRender();
    }

    return html;
}

// 渲染数学公式的函数。接受单个元素或元素数组：流式期间调用方只传本帧重建的那几个块，
// 避免把整条消息里已经排版好的公式一遍遍重排。
// 原来这里是每 100ms 轮询 window.MathJax 的死循环（没有公式时也永远等不到，只是没人 await）。
// 现在 MathJax（1.3MB）改成按需加载，第一次真的遇到公式时才注入。
export function renderMathInElement(element) {
    const targets = (Array.isArray(element) ? element : [element]).filter(Boolean);
    if (!targets.length) return Promise.resolve();
    return ensureMathJaxReady().then(() =>
        window.MathJax.typesetPromise(targets).catch((err) => {
            console.error('MathJax 渲染错误:', err);
            throw err;
        })
    );
}
