// 处理数学公式和 Markdown 的函数
let markedConfigured = false;
let mermaidRenderScheduled = false;

function scheduleMermaidRender() {
    if (mermaidRenderScheduled) return;
    mermaidRenderScheduled = true;
    const run = () => {
        mermaidRenderScheduled = false;
        if (window.renderMermaidDiagrams) {
            window.renderMermaidDiagrams();
        }
    };
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(run, { timeout: 300 });
    } else {
        setTimeout(run, 0);
    }
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
            fenceCloseRe = new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}(?:\\s|$)`);
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
            fenceCloseRe = new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}(?:\\s|$)`);
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

    text = text.replace(/\\\[([a-zA-Z\d]+)\]/g, '[$1]');

    // 添加 \mathds 字符映射
    const mathdsMap = {
        'A': '𝔸', 'B': '𝔹', 'C': 'ℂ', 'D': '𝔻', 'E': '𝔼',
        'F': '𝔽', 'G': '𝔾', 'H': 'ℍ', 'I': '𝕀', 'J': '𝕁',
        'K': '𝕂', 'L': '𝕃', 'M': '𝕄', 'N': 'ℕ', 'O': '𝕆',
        'P': 'ℙ', 'Q': 'ℚ', 'R': 'ℝ', 'S': '𝕊', 'T': '𝕋',
        'U': '𝕌', 'V': '𝕍', 'W': '𝕎', 'X': '𝕏', 'Y': '𝕐',
        'Z': 'ℤ',
        '0': '𝟘', '1': '𝟙', '2': '𝟚', '3': '𝟛', '4': '𝟜',
        '5': '𝟝', '6': '𝟞', '7': '𝟟', '8': '𝟠', '9': '𝟡'
    };

    // 处理 \mathds 命令
    text = text.replace(/\\mathds\{([A-Z0-9])\}/g, (match, char) => {
        return mathdsMap[char] || match;
    });

    // 替换行首的 \begin{align*} 为 \[
    text = text.replace(/^\s*\\begin\{align\*\}/gm, '\\[\n\\begin{align*}');
    // 替换行尾的 \end{align*} 为 \]
    text = text.replace(/\\end\{align\*\}\s*$/gm, '\\end{align*}\n\\]');

    text = text.replace(/\\label{eq:.*?}/gm, '');

    // 替换行首的 \begin{equation} 为 \[
    text = text.replace(/^\s*\\begin\{equation\}/gm, '\\[\n\\begin{equation}');
    // 替换行尾的 \end{equation} 为 \]
    text = text.replace(/\\end\{equation\}\s*$/gm, '\\end{equation}\n\\]');

    // 处理 \boxed 命令，将其包装在 \[ \] 中
    text = text.replace(/(\\\[\s*)?\$*\\boxed\{([\s\S]+)\}\$*(\s*\\\])?/g, '\\[\\boxed{$2}\\]');

    text = text.replace(/^---\n$/gm, '');

    // 处理 \textsc 命令
    text = text.replace(/\\textsc\{([^}]+)\}/g, (match, content) => {
        return content.toUpperCase();
    });

    // 处理 think 标签，将其转换为引用格式
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

    text = text.replace(/%\n\s*/g, ''); // 移除换行的百分号
    text = text.replace(/（\\\((.+?)\\）/g, '（\\($1\\)）');

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
        marked.setOptions({
            breaks: true,
            gfm: true,
            sanitize: false,
            highlight: function(code, lang) {
                if (lang === 'mermaid') {
                    return `<div class="mermaid">${code}</div>`;
                }
                if (lang && hljs.getLanguage(lang)) {
                    try {
                        return hljs.highlight(code, { language: lang }).value;
                    } catch (err) {
                        console.error('代码高亮错误:', err);
                    }
                }
                return hljs.highlightAuto(code).value;
            },
            renderer: Object.assign(new marked.Renderer(), {
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

    text = text.replace(/:\s\*\*/g, ':**');
    text = text.replace(/\*\*([^*]+?)\*\*[^\S\n]+/g, '@@$1@@#');
    text = text.replace(/\*\*(?=.*[^\S\n].*\*\*)([^*]+?)\*\*(?!\s)/g, '#%$1%#@');
    text = text.replace(/\*\*(?=.*：.*\*\*)([^*]+?)\*\*(?!\s)/g, '**$1** ');
    text = text.replace(/\@\@(.+?)\@\@#/g, '**$1** ');
    text = text.replace(/\#\%(.+?)\%\#\@/g, '**$1** ');
    text = text.replace(/ *\*\*([^\s]+?)\*\*(?!\s)/g, ' **$1** ');
    text = text.replace(/(\*\*.+?\*\*)\s：/g, '$1：');
    text = text.replace(/(\*\*.+?\*\*)\s，/g, '$1，');
    text = text.replace(/(\*\*.+?\*\*)\s,/g, '$1,');
    text = text.replace(/(\*\*.+?\*\*)\s\./g, '$1.');
    text = text.replace(/(\*\*.+?\*\*)\s。/g, '$1。');

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

// 渲染数学公式的函数
export function renderMathInElement(element) {
    return new Promise((resolve, reject) => {
        const checkMathJax = () => {
            if (window.MathJax && window.MathJax.typesetPromise) {
                MathJax.typesetPromise([element])
                    .then(() => {
                        resolve();
                    })
                    .catch((err) => {
                        console.error('MathJax 渲染错误:', err);
                        console.error('错误堆栈:', err.stack);
                        reject(err);
                    });
            } else {
                console.log('等待 MathJax 加载...');
                setTimeout(checkMathJax, 100); // 每100ms检查一次
            }
        };
        checkMathJax();
    });
}
