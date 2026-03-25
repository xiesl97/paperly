let currentDate = '';
let availableDates = [];
let currentView = 'grid'; // 'grid' 或 'list'
let currentCategory = 'all';
let paperData = {};
let flatpickrInstance = null;
let datePickerMode = 'single'; // 'single' | 'range' | 'multi'
let currentPaperIndex = 0; // 当前查看的论文索引
let currentFilteredPapers = []; // 当前过滤后的论文列表
let textSearchQuery = ''; // 实时文本搜索查询
let userTopics = []; // 用户自定义话题过滤标签
let activeTopics = new Set(); // currently active topic strings (multi-select)
let topicWordData = new Map(); // topic -> {words:[{word,count}], selectedWords:Set}
let topicWordLogic = 'OR'; // 'OR' | 'AND' — logic between selected words across active topics
let savedTopicSelections = new Map(); // topic -> Set of words, used to restore selections after buildTopicData

function persistFilterState() {
  try {
    const topicSelections = [];
    topicWordData.forEach((data, topic) => {
      topicSelections.push([topic, [...data.selectedWords]]);
    });
    sessionStorage.setItem('filterState', JSON.stringify({
      activeTopics: [...activeTopics],
      currentCategory,
      topicSelections,
      topicWordLogic,
    }));
  } catch (_) {}
}

function restoreFilterState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('filterState') || 'null');
    if (!saved) return;
    if (saved.currentCategory) currentCategory = saved.currentCategory;
    if (Array.isArray(saved.activeTopics)) activeTopics = new Set(saved.activeTopics);
    if (Array.isArray(saved.topicSelections)) {
      savedTopicSelections = new Map(
        saved.topicSelections.map(([topic, words]) => [topic, new Set(words)])
      );
    }
    if (saved.topicWordLogic === 'AND' || saved.topicWordLogic === 'OR') topicWordLogic = saved.topicWordLogic;
  } catch (_) {}
}
let lunrIndex = null; // lunr search index for topic filtering
let lunrIdSet = null;
let digestExcludedPapers = new Set(); // paper IDs excluded from AI digest
let lastDigestMarkdown = '';
let digestView = 'setup'; // 'setup' | 'generating' | 'result'
let digestState = { markdown: '', title: 'Research Digest', html: '', refHtml: '', selectedPapers: [] };

function persistDigestState() {
  try {
    sessionStorage.setItem('digestView', digestView === 'generating' ? 'setup' : digestView);
    sessionStorage.setItem('digestState', JSON.stringify({
      markdown: digestState.markdown,
      title: digestState.title,
      html: digestState.html,
      refHtml: digestState.refHtml,
    }));
    sessionStorage.setItem('digestExcluded', JSON.stringify([...digestExcludedPapers]));
  } catch (_) {}
}

function restoreDigestState() {
  try {
    const savedView = sessionStorage.getItem('digestView');
    const savedState = sessionStorage.getItem('digestState');
    const savedExcluded = sessionStorage.getItem('digestExcluded');
    if (savedView) digestView = savedView;
    if (savedState) Object.assign(digestState, JSON.parse(savedState));
    if (savedExcluded) digestExcludedPapers = new Set(JSON.parse(savedExcluded));
    if (digestView === 'result') lastDigestMarkdown = digestState.markdown;
  } catch (_) {}
}



function buildLunrIndex(data) {
  const docs = [];
  Object.values(data).forEach(papers => {
    papers.forEach(paper => {
      docs.push({
        id: paper.id,
        title: paper.title || '',
        tldr: paper.summary || '',       // summary field holds AI tldr
        details: paper.details || '',    // details holds original abstract
        motivation: paper.motivation || '',
        method: paper.method || '',
        result: paper.result || '',
        conclusion: paper.conclusion || '',
      });
    });
  });

  lunrIndex = lunr(function () {
    this.ref('id');
    this.field('title', { boost: 10 });
    this.field('tldr', { boost: 5 });
    this.field('details', { boost: 3 });
    this.field('motivation');
    this.field('method');
    this.field('result');
    this.field('conclusion');
    docs.forEach(doc => this.add(doc));
  });
}

// ── Topics row ──────────────────────────────────────────────────────────────

function loadUserTopics() {
  try {
    userTopics = JSON.parse(localStorage.getItem('userTopics') || '[]');
  } catch (e) {
    userTopics = [];
  }
  renderTopicsRow();
}

function saveUserTopics() {
  localStorage.setItem('userTopics', JSON.stringify(userTopics));
}

function getAllSelectedTopicWords() {
  const all = new Set();
  activeTopics.forEach(topic => {
    const data = topicWordData.get(topic);
    if (data) data.selectedWords.forEach(w => all.add(w));
  });
  return all;
}

function buildTopicData(topic, papers) {
  let words = [];
  if (lunrIndex) {
    try {
      const results = lunrIndex.search(topic);
      const matchedIds = new Set(results.map(r => r.ref));
      const allStems = new Set();
      results.forEach(r => Object.keys(r.matchData.metadata).forEach(s => allStems.add(s)));
      const matchedPapers = papers.filter(p => matchedIds.has(p.id));
      const wordCounts = new Map();
      matchedPapers.forEach(p => {
        const text = [p.title, p.summary, p.details, p.motivation, p.method, p.result, p.conclusion]
          .filter(Boolean).join(' ');
        const wordsInPaper = new Set();
        allStems.forEach(stem => {
          const re = new RegExp(`\\b(${stem}\\w*)`, 'gi');
          let m;
          while ((m = re.exec(text)) !== null) wordsInPaper.add(m[1].toLowerCase());
        });
        wordsInPaper.forEach(w => wordCounts.set(w, (wordCounts.get(w) || 0) + 1));
      });
      // Build word list from lunr-matched papers, then recount against all papers
      // so the displayed count matches how many papers would actually be shown
      const wordList = [...wordCounts.keys()];
      words = wordList.map(word => {
        const count = papers.reduce((n, p) => {
          const t = [p.title, p.summary, p.details, p.motivation, p.method, p.result, p.conclusion]
            .filter(Boolean).join(' ').toLowerCase();
          return n + (t.includes(word) ? 1 : 0);
        }, 0);
        return { word, count };
      }).sort((a, b) => b.count - a.count);
    } catch (e) { /* fall through to empty words */ }
  }
  // Fallback for acronyms/terms lunr can't match: use direct substring search
  if (words.length === 0) {
    const topicLower = topic.toLowerCase();
    const matchedPapers = papers.filter(p => {
      const t = [p.title, p.summary, p.details, p.motivation, p.method, p.result, p.conclusion]
        .filter(Boolean).join(' ').toLowerCase();
      return t.includes(topicLower);
    });
    words = [{ word: topicLower, count: matchedPapers.length }];
  }
  // Restore saved selection if available, otherwise default to exact-match terms
  let selectedWords;
  if (savedTopicSelections.has(topic)) {
    const saved = savedTopicSelections.get(topic);
    selectedWords = new Set(words.filter(w => saved.has(w.word)).map(w => w.word));
    savedTopicSelections.delete(topic);
  } else {
    const topicTerms = new Set(topic.toLowerCase().split(/\s+/).filter(Boolean));
    selectedWords = new Set(words.filter(w => topicTerms.has(w.word)).map(w => w.word));
  }
  return { words, selectedWords };
}

function renderTopicsRow() {
  const container = document.getElementById('topicTags');
  if (!container) return;
  container.innerHTML = '';

  userTopics.forEach(topic => {
    const btn = document.createElement('button');
    btn.className = `topic-button ${activeTopics.has(topic) ? 'active' : ''}`;
    btn.dataset.topic = topic;

    const label = document.createElement('span');
    label.textContent = topic;

    const removeBtn = document.createElement('span');
    removeBtn.className = 'topic-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove topic';
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      removeTopic(topic);
    });

    btn.appendChild(label);
    btn.appendChild(removeBtn);
    btn.addEventListener('click', () => filterByTopic(topic));
    container.appendChild(btn);
  });
}

function renderTopicWordPicker() {
  const row = document.getElementById('topicWordPickerRow');
  const container = document.getElementById('topicWordPickerTags');
  if (!row || !container) return;

  if (activeTopics.size === 0) {
    row.style.display = 'none';
    return;
  }

  row.style.display = 'flex';
  container.innerHTML = '';

  // Logic toggle row
  const logicRow = document.createElement('div');
  logicRow.className = 'topic-logic-row';
  const logicLabel = document.createElement('span');
  logicLabel.className = 'topic-logic-label';
  logicLabel.textContent = 'Match:';
  logicRow.appendChild(logicLabel);
  ['OR', 'AND'].forEach(mode => {
    const btn = document.createElement('button');
    btn.className = `topic-logic-btn${topicWordLogic === mode ? ' active' : ''}`;
    btn.textContent = mode;
    btn.addEventListener('click', () => {
      topicWordLogic = mode;
      persistFilterState();
      renderTopicWordPicker();
      renderPapers();
    });
    logicRow.appendChild(btn);
  });
  container.appendChild(logicRow);

  activeTopics.forEach(topic => {
    const data = topicWordData.get(topic);
    if (!data || data.words.length === 0) return;

    const subRow = document.createElement('div');
    subRow.className = 'topic-words-sub-row';

    const label = document.createElement('span');
    label.className = 'topic-words-sub-label';
    label.textContent = topic;
    subRow.appendChild(label);

    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'topic-words-sub-tags';

    data.words.forEach(({ word, count }) => {
      const btn = document.createElement('button');
      const isSelected = data.selectedWords.has(word);
      btn.className = `topic-word-btn ${isSelected ? 'active' : ''}`;
      btn.innerHTML = `${word} <span class="topic-word-count">${count}</span>`;
      btn.title = isSelected ? 'Click to exclude' : 'Click to include';
      btn.addEventListener('click', () => {
        if (data.selectedWords.has(word)) data.selectedWords.delete(word);
        else data.selectedWords.add(word);
        persistFilterState();
        renderTopicWordPicker();
        renderPapers();
      });
      tagsDiv.appendChild(btn);
    });

    subRow.appendChild(tagsDiv);
    container.appendChild(subRow);
  });
}

function filterByTopic(topic) {
  if (activeTopics.has(topic)) {
    activeTopics.delete(topic);
    topicWordData.delete(topic);
    renderTopicWordPicker(); // immediately remove that topic's word row
  } else {
    activeTopics.add(topic);
  }
  if (activeTopics.size === 0) {
    const row = document.getElementById('topicWordPickerRow');
    if (row) row.style.display = 'none';
  }
  persistFilterState();
  renderTopicsRow();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderPapers();
}

function addTopic(keyword) {
  const k = keyword.trim();
  if (!k || userTopics.includes(k)) return;
  userTopics.push(k);
  saveUserTopics();
  renderTopicsRow();
}

function removeTopic(keyword) {
  userTopics = userTopics.filter(t => t !== keyword);
  activeTopics.delete(keyword);
  topicWordData.delete(keyword);
  saveUserTopics();
  renderTopicsRow();
  renderPapers();
}

// ── End Topics row ───────────────────────────────────────────────────────────

// ── Config-required modal ─────────────────────────────────────────────────────
function showConfigRequiredModal(type) {
  const overlay = document.getElementById('configRequiredModal');
  const content = document.getElementById('configRequiredContent');
  if (!overlay || !content) return;

  if (type === 'ai') {
    content.innerHTML = `
      <h3>AI features need configuration</h3>
      <p>To use AI-powered analysis and digest generation, you need to provide your API credentials in Settings.</p>
      <div class="config-required-fields">
        <strong>Required fields:</strong><br>
        · AI API URL (e.g. https://api.openai.com/v1)<br>
        · Model name (e.g. gpt-4o-mini)<br>
        · API key
      </div>
      <p>Once configured, AI features will be available for generating paper summaries and research digests.</p>
      <div class="config-required-actions">
        <a href="settings.html">Go to Settings</a>
      </div>`;
  } else if (type === 'save') {
    content.innerHTML = `
      <h3>Saving is not available for visitors</h3>
      <p>Persisting AI-generated content back to the data file requires a GitHub token with write access to the repository.</p>
      <p>As a visitor, AI analysis still works locally — results are shown in the paper modal but not saved to the shared dataset.</p>`;
  }

  overlay.style.display = 'flex';
}

function closeConfigRequiredModal() {
  const overlay = document.getElementById('configRequiredModal');
  if (overlay) overlay.style.display = 'none';
}

function updateTitleBadges() {
  const hasAI = !!localStorage.getItem('aiApiKey');
  const hasToken = !!localStorage.getItem('githubToken');

  const aiEl = document.getElementById('aiEnabledBadge');
  if (aiEl) {
    aiEl.classList.toggle('unconfigured', !hasAI);
    aiEl.title = hasAI ? '' : 'AI features need configuration — click to learn more';
    aiEl.onclick = !hasAI ? (e) => { e.preventDefault(); e.stopPropagation(); showConfigRequiredModal('ai'); } : null;
    aiEl.style.cursor = hasAI ? '' : 'help';
  }

  const visitorEl = document.getElementById('visitorBadge');
  if (visitorEl) visitorEl.style.display = hasToken ? 'none' : '';
}
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  restoreDigestState();
  updateDigestNavBtn();
  initEventListeners();
  updateTitleBadges();


  // 加载用户话题
  loadUserTopics();

  // Restore filter state from session (overrides defaults set above)
  restoreFilterState();
  // Re-render topics row so buttons reflect restored activeTopics
  renderTopicsRow();

  // Wire up add-topic UI
  const addTopicBtn = document.getElementById('addTopicBtn');
  const topicInputContainer = document.getElementById('topicInputContainer');
  const topicInput = document.getElementById('topicInput');
  const topicConfirm = document.getElementById('topicInputConfirm');
  const topicCancel = document.getElementById('topicInputCancel');

  addTopicBtn.addEventListener('click', () => {
    topicInputContainer.style.display = 'flex';
    addTopicBtn.style.display = 'none';
    topicInput.focus();
  });

  function commitTopic() {
    addTopic(topicInput.value);
    topicInput.value = '';
    topicInputContainer.style.display = 'none';
    addTopicBtn.style.display = '';
  }

  topicConfirm.addEventListener('click', commitTopic);
  topicCancel.addEventListener('click', () => {
    topicInput.value = '';
    topicInputContainer.style.display = 'none';
    addTopicBtn.style.display = '';
  });
  topicInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') commitTopic();
    if (e.key === 'Escape') topicCancel.click();
  });

  fetchAvailableDates().then(() => {
    if (availableDates.length > 0) {
      loadPapersByDate(availableDates[0]);
    }
  });


  // Persist state reliably on every navigation away (covers bfcache and full-unload)
  window.addEventListener('pagehide', () => {
    persistDigestState();
    persistFilterState();
  });

  // Restore state on bfcache restore (persisted=true) — DOMContentLoaded does NOT fire in that case
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      restoreDigestState();
      restoreFilterState();
      updateDigestNavBtn();
    }
  });
});

// --- Auto-collapse nav on scroll (direction-based) ---
{
  let navCollapsed = false;
  let cooldown = false;
  let lastScrollY = window.scrollY;

  function applyNavCollapse(collapsed) {
    if (navCollapsed === collapsed) return;
    navCollapsed = collapsed;
    // Ignore scroll events during the CSS transition to avoid layout-shift feedback
    cooldown = true;
    setTimeout(() => { cooldown = false; lastScrollY = window.scrollY; }, 350);
    document.getElementById('categoryNav')?.classList.toggle('nav-collapsed', collapsed);
  }

  window.addEventListener('scroll', () => {
    if (cooldown) return;
    const y = window.scrollY;
    const delta = y - lastScrollY;
    lastScrollY = y;
    if (delta > 4 && !navCollapsed && y > 60) applyNavCollapse(true);
    else if (delta < -4 && navCollapsed) applyNavCollapse(false);
  }, { passive: true });

  // Keep manual toggle in sync
  window._navCollapseState = () => navCollapsed;
  window._setNavCollapse = applyNavCollapse;
}

function toggleNavCollapse() {
  const nav = document.getElementById('categoryNav');
  if (!nav) return;
  if (window._setNavCollapse) {
    window._setNavCollapse(!window._navCollapseState());
  } else {
    nav.classList.toggle('nav-collapsed');
  }
}


function initEventListeners() {
  // 日期选择器相关的事件监听
  const calendarButton = document.getElementById('calendarButton');
  calendarButton.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDatePicker();
  });
  
  const datePickerModal = document.querySelector('.date-picker-modal');
  datePickerModal.addEventListener('click', (event) => {
    if (event.target === datePickerModal) {
      toggleDatePicker();
    }
  });
  
  const datePickerContent = document.querySelector('.date-picker-content');
  datePickerContent.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // date mode buttons wired via onclick in HTML
  
  // 其他原有的事件监听器
  document.getElementById('closeModal').addEventListener('click', closeModal);

  // When the PDF iframe steals focus, immediately return focus to the parent window
  // so arrow keys always navigate papers rather than scroll the iframe.
  window.addEventListener('blur', () => {
    const paperModal = document.getElementById('paperModal');
    if (paperModal && paperModal.classList.contains('active')) {
      setTimeout(() => window.focus(), 0);
    }
  });
  
  document.querySelector('.paper-modal').addEventListener('click', (event) => {
    const modal = document.querySelector('.paper-modal');
    const pdfContainer = modal.querySelector('.pdf-container');
    
    // 如果点击的是模态框背景
    if (event.target === modal) {
      // 检查PDF是否处于放大状态
      if (pdfContainer && pdfContainer.classList.contains('expanded')) {
        // 如果PDF是放大的，先将其恢复正常大小
        const expandButton = modal.querySelector('.pdf-expand-btn');
        if (expandButton) {
          togglePdfSize(expandButton);
        }
        // 阻止事件继续传播，防止关闭整个模态框
        event.stopPropagation();
      } else {
        // 如果PDF不是放大状态，则关闭整个模态框
        closeModal();
      }
    }
  });
  
  // 添加键盘事件监听 - Esc 键关闭模态框，左右箭头键切换论文，R 键显示随机论文
  document.addEventListener('keydown', (event) => {
    // 检查是否有输入框或文本区域处于焦点状态
    const activeElement = document.activeElement;
    const isInputFocused = activeElement && (
      activeElement.tagName === 'INPUT' || 
      activeElement.tagName === 'TEXTAREA' || 
      activeElement.isContentEditable
    );
    
    if (event.key === 'Escape') {
      const paperModal = document.getElementById('paperModal');
      const datePickerModal = document.getElementById('datePickerModal');
      
      // 关闭论文模态框
      if (paperModal.classList.contains('active')) {
        closeModal();
      }
      // 关闭日期选择器模态框
      else if (datePickerModal.classList.contains('active')) {
        toggleDatePicker();
      }
    }
    // 左右箭头键导航论文（仅在论文模态框打开时）
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const paperModal = document.getElementById('paperModal');
      if (paperModal.classList.contains('active') && !isInputFocused) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'ArrowLeft') {
          navigateToPreviousPaper();
        } else {
          navigateToNextPaper();
        }
      }
    }
    // space 键显示随机论文（在没有输入框焦点且日期选择器未打开时）
    else if (event.key === ' ' || event.key === 'Spacebar') {
      const paperModal = document.getElementById('paperModal');
      const datePickerModal = document.getElementById('datePickerModal');
      
      // 只有在没有输入框焦点且日期选择器没有打开时才触发
      // 现在允许在论文模态框打开时也能使用R键切换到随机论文
      if (!isInputFocused && !datePickerModal.classList.contains('active')) {
        event.preventDefault(); // 防止页面刷新
        event.stopPropagation(); // 阻止事件冒泡
        showRandomPaper();
      }
    }
  });
  
  // 添加鼠标滚轮横向滚动支持
  const categoryScroll = document.querySelector('.category-scroll');
  const keywordScroll = document.querySelector('.keyword-scroll');
  const authorScroll = document.querySelector('.author-scroll');
  
  // 为类别滚动添加鼠标滚轮事件
  if (categoryScroll) {
    categoryScroll.addEventListener('wheel', function(e) {
      if (e.deltaY !== 0) {
        e.preventDefault();
        this.scrollLeft += e.deltaY;
      }
    });
  }
  
  // 为关键词滚动添加鼠标滚轮事件
  if (keywordScroll) {
    keywordScroll.addEventListener('wheel', function(e) {
      if (e.deltaY !== 0) {
        e.preventDefault();
        this.scrollLeft += e.deltaY;
      }
    });
  }
  
  // 为作者滚动添加鼠标滚轮事件
  if (authorScroll) {
    authorScroll.addEventListener('wheel', function(e) {
      if (e.deltaY !== 0) {
        e.preventDefault();
        this.scrollLeft += e.deltaY;
      }
    });
  }

  // 其他事件监听器...
  const categoryButtons = document.querySelectorAll('.category-button');
  categoryButtons.forEach(button => {
    button.addEventListener('click', () => {
      const category = button.dataset.category;
      filterByCategory(category);
    });
  });

  // 回到顶部按钮：滚动显示/隐藏 + 点击回到顶部
  const backToTopButton = document.getElementById('backToTop');
  if (backToTopButton) {
    const updateBackToTopVisibility = () => {
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
      if (scrollTop > 300) {
        backToTopButton.classList.add('visible');
      } else {
        backToTopButton.classList.remove('visible');
      }
    };

    // 初始判断一次（防止刷新在中部时不显示）
    updateBackToTopVisibility();
    window.addEventListener('scroll', updateBackToTopVisibility, { passive: true });

    backToTopButton.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // 文本搜索：放大镜切换显示输入框
  const searchToggle = document.getElementById('textSearchToggle');
  const searchWrapper = document.querySelector('#textSearchContainer .search-input-wrapper');
  const searchInput = document.getElementById('textSearchInput');
  const searchClear = document.getElementById('textSearchClear');

  if (searchToggle && searchWrapper && searchInput && searchClear) {
    searchToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      searchWrapper.style.display = 'flex';
      searchInput.focus();
    });

    // 输入时更新查询并重新渲染
    const handleInput = () => {
      const value = searchInput.value.trim();
      textSearchQuery = value;
      if (textSearchQuery.length === 0) {
        searchWrapper.style.display = 'none';
      }

      // 控制清除按钮显示
      searchClear.style.display = textSearchQuery.length > 0 ? 'inline-flex' : 'none';

      renderPapers();
    };

    searchInput.addEventListener('input', handleInput);

    // 清除按钮：清空文本，恢复其他过滤
    searchClear.addEventListener('click', (e) => {
      e.stopPropagation();
      searchInput.value = '';
      textSearchQuery = '';
      searchClear.style.display = 'none';
      renderPapers();
      // 清空后隐藏输入框
      searchWrapper.style.display = 'none';
    });

    // 失焦时：若文本为空则隐藏输入框（保持有文本时不隐藏）
    searchInput.addEventListener('blur', () => {
      const value = searchInput.value.trim();
      if (value.length === 0) {
        searchWrapper.style.display = 'none';
      }
    });

    // 点击其他地方不隐藏输入框（需求4），因此不添加blur隐藏逻辑
  }
}

// Function to detect preferred language based on browser settings
function getPreferredLanguage() {
  const browserLang = navigator.language || navigator.userLanguage;
  // Check if browser is set to Chinese variants
  if (browserLang.startsWith('zh')) {
    return 'Chinese';
  }
  // Default to Chinese for all other languages
  return 'Chinese';
}

// Function to select the best available language for a date
function selectLanguageForDate(date, preferredLanguage = null) {
  const availableLanguages = window.dateLanguageMap?.get(date) || [];
  
  if (availableLanguages.length === 0) {
    return 'Chinese'; // fallback
  }
  
  // Use provided preference or detect from browser
  const preferred = preferredLanguage || getPreferredLanguage();
  
  // If preferred language is available, use it
  if (availableLanguages.includes(preferred)) {
    return preferred;
  }
  
  // Fallback: prefer Chinese if available, otherwise use the first available
  return availableLanguages.includes('Chinese') ? 'Chinese' : availableLanguages[0];
}

async function fetchAvailableDates() {
  try {
    // 从 data 分支获取文件列表
    const fileListUrl = DATA_CONFIG.getDataUrl('assets/file-list.txt');
    const response = await fetch(fileListUrl);
    if (!response.ok) {
      console.error('Error fetching file list:', response.status);
      return [];
    }
    const text = await response.text();
    const files = text.trim().split('\n');

    const plainRegex = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
    const aiRegex = /(\d{4}-\d{2}-\d{2})_AI_enhanced_(English|Chinese)\.jsonl/;
    const dateLanguageMap = new Map();
    const plainDates = new Set();

    files.forEach(file => {
      const f = file.trim();
      const plainMatch = f.match(plainRegex);
      if (plainMatch) {
        plainDates.add(plainMatch[1]);
        return;
      }
      const aiMatch = f.match(aiRegex);
      if (aiMatch) {
        const date = aiMatch[1], lang = aiMatch[2];
        if (!dateLanguageMap.has(date)) dateLanguageMap.set(date, []);
        dateLanguageMap.get(date).push(lang);
      }
    });

    window.dateLanguageMap = dateLanguageMap;
    window.plainDates = plainDates;
    const allDates = new Set([...plainDates, ...dateLanguageMap.keys()]);
    availableDates = [...allDates];
    availableDates.sort((a, b) => new Date(b) - new Date(a));

    initDatePicker(); // Assuming this function uses availableDates

    return availableDates;
  } catch (error) {
    console.error('获取可用日期失败:', error);
  }
}

function initDatePicker() {
  const datepickerInput = document.getElementById('datepicker');
  
  if (flatpickrInstance) {
    flatpickrInstance.destroy();
  }
  
  // 创建可用日期的映射，用于禁用无效日期
  const enabledDatesMap = {};
  availableDates.forEach(date => {
    enabledDatesMap[date] = true;
  });
  
  // 配置 Flatpickr
  flatpickrInstance = flatpickr(datepickerInput, {
    inline: true,
    dateFormat: "Y-m-d",
    mode: datePickerMode === 'range' ? 'range' : datePickerMode === 'multi' ? 'multiple' : 'single',
    defaultDate: availableDates[0],
    enable: [
      function(date) {
        const dateStr = date.getFullYear() + "-" +
                        String(date.getMonth() + 1).padStart(2, '0') + "-" +
                        String(date.getDate()).padStart(2, '0');
        return dateStr <= availableDates[0];
      }
    ],
    onChange: function(selectedDates) {
      if (datePickerMode === 'range' && selectedDates.length === 2) {
        const startDate = formatDateForAPI(selectedDates[0]);
        const endDate = formatDateForAPI(selectedDates[1]);
        loadPapersByDateRange(startDate, endDate);
        toggleDatePicker();
      } else if (datePickerMode === 'single' && selectedDates.length === 1) {
        loadPapersByDate(formatDateForAPI(selectedDates[0]));
        toggleDatePicker();
      } else if (datePickerMode === 'multi') {
        // Update the load button label with count
        const btn = document.getElementById('loadMultiDatesBtn');
        if (btn) btn.textContent = `Load ${selectedDates.length} date${selectedDates.length !== 1 ? 's' : ''}`;
      }
    }
  });
  
  // 隐藏日期输入框
  const inputElement = document.querySelector('.flatpickr-input');
  if (inputElement) {
    inputElement.style.display = 'none';
  }
}

function formatDateForAPI(date) {
  return date.getFullYear() + "-" + 
         String(date.getMonth() + 1).padStart(2, '0') + "-" + 
         String(date.getDate()).padStart(2, '0');
}

function setDateMode(mode) {
  datePickerMode = mode;

  // Update button active states
  document.querySelectorAll('.date-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  // Show/hide load button for multi mode
  const loadBtn = document.getElementById('loadMultiDatesBtn');
  if (loadBtn) {
    loadBtn.style.display = mode === 'multi' ? '' : 'none';
    loadBtn.textContent = 'Load Selected';
  }

  if (flatpickrInstance) {
    flatpickrInstance.set('mode', mode === 'range' ? 'range' : mode === 'multi' ? 'multiple' : 'single');
    flatpickrInstance.clear();
  }
}

function loadSelectedMultiDates() {
  if (!flatpickrInstance) return;
  const selectedDates = flatpickrInstance.selectedDates;
  if (selectedDates.length === 0) return;
  const dates = selectedDates.map(formatDateForAPI).sort((a, b) => b.localeCompare(a));
  loadPapersByDates(dates);
  toggleDatePicker();
}

function getDataUrlForDate(date) {
  if (window.plainDates?.has(date)) {
    return DATA_CONFIG.getDataUrl(`data/${date}.jsonl`);
  }
  const lang = selectLanguageForDate(date);
  return DATA_CONFIG.getDataUrl(`data/${date}_AI_enhanced_${lang}.jsonl`);
}

async function loadPapersByDate(date) {
  currentDate = date;
  document.getElementById('currentDate').textContent = formatDate(date);
  
  // 更新日期选择器中的选中日期
  if (flatpickrInstance) {
    flatpickrInstance.setDate(date, false);
  }
  
  // 不再重置激活的关键词和作者
  // 而是保持当前选择状态
  
  const container = document.getElementById('paperContainer');
  container.innerHTML = `
    <div class="loading-container">
      <div class="loading-spinner"></div>
      <p>Loading paper...</p>
    </div>
  `;
  
  try {
    const dataUrl = getDataUrlForDate(date);
    const response = await fetch(dataUrl, { cache: 'no-store' });
    // 如果文件不存在（例如返回 404），在论文展示区域提示没有论文
    if (!response.ok) {
      if (response.status === 404) {
        container.innerHTML = `
          <div class="loading-container">
            <p>No papers found for this date.</p>
          </div>
        `;
        paperData = {};
        renderCategoryFilter({ sortedCategories: [], categoryCounts: {} });
        return;
      }
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    // 空文件也提示没有论文
    if (!text || text.trim() === '') {
      container.innerHTML = `
        <div class="loading-container">
          <p>No papers found for this date.</p>
        </div>
      `;
      paperData = {};
      renderCategoryFilter({ sortedCategories: [], categoryCounts: {} });
      return;
    }
    
    paperData = parseJsonlData(text, date);
    buildLunrIndex(paperData);

    const categories = getAllCategories(paperData);
    
    renderCategoryFilter(categories);
    
    renderPapers();
  } catch (error) {
    console.error('加载论文数据失败:', error);
    container.innerHTML = `
      <div class="loading-container">
        <p>Loading data fails. Please retry.</p>
        <p>Error messages: ${error.message}</p>
      </div>
    `;
  }
}

function parseJsonlData(jsonlText, date) {
  const result = {};
  
  const lines = jsonlText.trim().split('\n');
  
  lines.forEach(line => {
    try {
      const paper = JSON.parse(line);
      
      if (!paper.categories) {
        return;
      }
      
      let allCategories = Array.isArray(paper.categories) ? paper.categories : [paper.categories];
      
      const primaryCategory = allCategories[0];
      
      if (!result[primaryCategory]) {
        result[primaryCategory] = [];
      }
      
      const summary = paper.AI?.tldr || '';
      
      result[primaryCategory].push({
        title: paper.title,
        url: paper.abs || paper.pdf || `https://arxiv.org/abs/${paper.id}`,
        authors: Array.isArray(paper.authors) ? paper.authors.join(', ') : paper.authors,
        category: allCategories,
        summary: summary,
        details: paper.summary || '',
        date: date,
        id: paper.id,
        motivation: paper.AI && paper.AI.motivation ? paper.AI.motivation : '',
        method: paper.AI && paper.AI.method ? paper.AI.method : '',
        result: paper.AI && paper.AI.result ? paper.AI.result : '',
        conclusion: paper.AI && paper.AI.conclusion ? paper.AI.conclusion : '',
        comment: paper.comment || '',
        published: paper.published || '',
        code_url: paper.code_url || '',
        code_stars: paper.code_stars || 0,
        code_last_update: paper.code_last_update || ''
      });
    } catch (error) {
      console.error('解析JSON行失败:', error, line);
    }
  });
  
  return result;
}

// 获取所有类别并按偏好排序
function getAllCategories(data) {
  const categories = Object.keys(data);
  const catePaperCount = {};
  
  categories.forEach(category => {
    catePaperCount[category] = data[category] ? data[category].length : 0;
  });
  
  return {
    sortedCategories: categories.sort((a, b) => {
      return a.localeCompare(b);
    }),
    categoryCounts: catePaperCount
  };
}

function renderCategoryFilter(categories) {
  const container = document.querySelector('.category-scroll');
  const { sortedCategories, categoryCounts } = categories;
  
  let totalPapers = 0;
  Object.values(categoryCounts).forEach(count => {
    totalPapers += count;
  });
  
  container.innerHTML = `
    <button class="category-button ${currentCategory === 'all' ? 'active' : ''}" data-category="all">All<span class="category-count">${totalPapers}</span></button>
  `;
  
  sortedCategories.forEach(category => {
    const count = categoryCounts[category];
    const button = document.createElement('button');
    button.className = `category-button ${category === currentCategory ? 'active' : ''}`;
    button.innerHTML = `${category}<span class="category-count">${count}</span>`;
    button.dataset.category = category;
    button.addEventListener('click', () => {
      filterByCategory(category);
    });
    
    container.appendChild(button);
  });
  
  document.querySelector('.category-button[data-category="all"]').addEventListener('click', () => {
    filterByCategory('all');
  });
}

function filterByCategory(category) {
  currentCategory = category;
  activeTopics.clear();
  topicWordData.clear();
  const row = document.getElementById('topicWordPickerRow');
  if (row) row.style.display = 'none';
  renderTopicsRow();

  document.querySelectorAll('.category-button').forEach(button => {
    button.classList.toggle('active', button.dataset.category === category);
  });

  // 重置页面滚动条到顶部
  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  });

  persistFilterState();
  renderPapers();
}

// 帮助函数：高亮文本中的匹配内容
function highlightMatches(text, terms, className = 'highlight-match') {
  if (!terms || terms.length === 0 || !text) {
    return text;
  }
  
  let result = text;
  
  // 按照长度排序关键词，从长到短，避免短词先替换导致长词匹配失败
  const sortedTerms = [...terms].sort((a, b) => b.length - a.length);
  
  // 为每个词创建一个正则表达式，使用 'gi' 标志进行全局、不区分大小写的匹配
  sortedTerms.forEach(term => {
    const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    result = result.replace(regex, `<span class="${className}">$1</span>`);
  });
  
  return result;
}

// 帮助函数：使用词干前缀高亮文本（stem → matches stem, stemming, stemmed, etc.）
function highlightStemMatches(text, stems, className = 'highlight-match') {
  if (!stems || stems.length === 0 || !text) return text;
  let result = text;
  stems.forEach(stem => {
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped}\\w*)`, 'gi');
    result = result.replace(regex, `<span class="${className}">$1</span>`);
  });
  return result;
}

// 帮助函数：格式化作者列表（用于论文卡片显示）
// 规则：≤4个作者全部显示，>4个作者显示前2+后2，中间用省略号
function formatAuthorsForCard(authorsString, authorTerms = []) {
  if (!authorsString) {
    return '';
  }
  
  // 将作者字符串解析为数组（处理逗号分隔的情况）
  const authorsArray = authorsString.split(',').map(author => author.trim()).filter(author => author.length > 0);
  
  if (authorsArray.length === 0) {
    return '';
  }
  
  // 如果不超过4个作者，全部显示
  if (authorsArray.length <= 4) {
    return authorsArray.map(author => {
      // 对每个作者应用高亮
      const highlightedAuthor = authorTerms.length > 0 
        ? highlightMatches(author, authorTerms, 'author-highlight')
        : author;
      return `<span class="author-item">${highlightedAuthor}</span>`;
    }).join(', ');
  }
  
  // 超过4个作者：显示前2个、省略号、后2个
  const firstTwo = authorsArray.slice(0, 2);
  const lastTwo = authorsArray.slice(-2);
  
  const result = [];
  
  // 前2个作者
  firstTwo.forEach(author => {
    const highlightedAuthor = authorTerms.length > 0 
      ? highlightMatches(author, authorTerms, 'author-highlight')
      : author;
    result.push(`<span class="author-item">${highlightedAuthor}</span>`);
  });
  
  // 省略号
  result.push('<span class="author-ellipsis">...</span>');
  
  // 后2个作者
  lastTwo.forEach(author => {
    const highlightedAuthor = authorTerms.length > 0 
      ? highlightMatches(author, authorTerms, 'author-highlight')
      : author;
    result.push(`<span class="author-item">${highlightedAuthor}</span>`);
  });
  
  return result.join(', ');
}

function renderPapers() {
  const container = document.getElementById('paperContainer');
  container.innerHTML = '';
  container.className = `paper-container ${currentView === 'list' ? 'list-view' : ''}`;
  
  let papers = [];
  if (currentCategory === 'all') {
    const { sortedCategories } = getAllCategories(paperData);
    const seen = new Set();
    sortedCategories.forEach(category => {
      if (paperData[category]) {
        paperData[category].forEach(p => {
          if (!seen.has(p.id)) {
            seen.add(p.id);
            papers.push(p);
          }
        });
      }
    });
  } else if (paperData[currentCategory]) {
    papers = paperData[currentCategory];
  }

  // 话题过滤
  if (activeTopics.size > 0) {
    let needsPickerRender = false;
    activeTopics.forEach(topic => {
      if (!topicWordData.has(topic)) {
        topicWordData.set(topic, buildTopicData(topic, papers));
        needsPickerRender = true;
      }
    });
    if (needsPickerRender) renderTopicWordPicker();

    // Paper matches based on topicWordLogic (OR: any word matches, AND: all words match)
    papers = papers.filter(p => {
      const text = [p.title, p.summary, p.details, p.motivation, p.method, p.result, p.conclusion]
        .filter(Boolean).join(' ').toLowerCase();
      const allWords = getAllSelectedTopicWords();
      if (allWords.size === 0) return false;
      if (topicWordLogic === 'AND') {
        return [...allWords].every(w => text.includes(w));
      } else {
        return [...allWords].some(w => text.includes(w));
      }
    });
  }

  // 创建匹配论文的集合
  let filteredPapers = [...papers];

  // 重置所有论文的匹配状态，避免上次渲染的残留
  filteredPapers.forEach(p => {
    p.isMatched = false;
    p.matchReason = undefined;
  });

  // 文本搜索优先：当存在非空文本时，像关键词/作者一样只排序不隐藏
  if (textSearchQuery && textSearchQuery.trim().length > 0) {
    const q = textSearchQuery.toLowerCase();

    // 排序：匹配的排前
    filteredPapers.sort((a, b) => {
      const hayA = [
        a.title,
        a.authors,
        Array.isArray(a.category) ? a.category.join(', ') : a.category,
        a.summary,
        a.details || '',
        a.motivation || '',
        a.method || '',
        a.result || '',
        a.conclusion || ''
      ].join(' ').toLowerCase();
      const hayB = [
        b.title,
        b.authors,
        Array.isArray(b.category) ? b.category.join(', ') : b.category,
        b.summary,
        b.details || '',
        b.motivation || '',
        b.method || '',
        b.result || '',
        b.conclusion || ''
      ].join(' ').toLowerCase();
      const am = hayA.includes(q);
      const bm = hayB.includes(q);
      if (am && !bm) return -1;
      if (!am && bm) return 1;
      return 0;
    });

    // 标记匹配项，用于卡片样式与提示
    filteredPapers.forEach(p => {
      const hay = [
        p.title,
        p.authors,
        Array.isArray(p.category) ? p.category.join(', ') : p.category,
        p.summary,
        p.details || '',
        p.motivation || '',
        p.method || '',
        p.result || '',
        p.conclusion || ''
      ].join(' ').toLowerCase();
      const matched = hay.includes(q);
      p.isMatched = matched;
      p.matchReason = matched ? [`文本: ${textSearchQuery}`] : undefined;
    });
  } else {
    filteredPapers.forEach(paper => { paper.isMatched = false; });
  }

  // 存储当前过滤后的论文列表，用于箭头键导航
  currentFilteredPapers = [...filteredPapers];
  
  if (filteredPapers.length === 0) {
    container.innerHTML = `
      <div class="loading-container">
        <p>No paper found.</p>
      </div>
    `;
    return;
  }
  
  filteredPapers.forEach((paper, index) => {
    const paperCard = document.createElement('div');
    // 添加匹配高亮类
    paperCard.className = `paper-card ${paper.isMatched ? 'matched-paper' : ''}`;
    paperCard.dataset.id = paper.id || paper.url;
    
    if (paper.isMatched) {
      // 添加匹配原因提示
      paperCard.title = `匹配: ${paper.matchReason.join(' | ')}`;
    }
    
    const categoryTags = paper.allCategories ? 
      paper.allCategories.map(cat => `<span class="category-tag">${cat}</span>`).join('') : 
      `<span class="category-tag">${paper.category}</span>`;
    
    // 组合需要高亮的词：话题选中词 + 文本搜索
    const titleSummaryTerms = [...getAllSelectedTopicWords()];
    if (textSearchQuery && textSearchQuery.trim().length > 0) {
      titleSummaryTerms.push(textSearchQuery.trim());
    }

    let highlightedTitle = titleSummaryTerms.length > 0
      ? highlightMatches(paper.title, titleSummaryTerms, 'keyword-highlight')
      : paper.title;
    const cardSummaryText = paper.summary || paper.details;
    let highlightedSummary = titleSummaryTerms.length > 0
      ? highlightMatches(cardSummaryText, titleSummaryTerms, 'keyword-highlight')
      : cardSummaryText;

    // 高亮作者（文本搜索）
    const authorTerms = [];
    if (textSearchQuery && textSearchQuery.trim().length > 0) authorTerms.push(textSearchQuery.trim());
    
    // 格式化作者列表（应用截断规则和高亮）
    const formattedAuthors = formatAuthorsForCard(paper.authors, authorTerms);
    
    // 构建 GitHub 按钮 HTML
    // let githubHtml = '';
    // if (paper.code_url) {
    //   const stars = paper.code_stars ? `<span class="github-stars">★ ${paper.code_stars}</span>` : '';
    //   const isHot = paper.code_stars > 100;
      
    //   githubHtml = `
    //     <a href="${paper.code_url}" target="_blank" class="github-link" title="View Code" onclick="event.stopPropagation()">
    //       <svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: text-bottom; margin-right: 4px;">
    //         <path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
    //       </svg>
    //       Code ${stars}
    //       ${isHot ? '<span class="hot-icon">🔥</span>' : ''}
    //     </a>
    //   `;
    // }

    paperCard.innerHTML = `
      <button class="paper-card-index ${digestExcludedPapers.has(paper.id) ? 'excluded' : ''}"
        data-pid="${paper.id}"
        onclick="event.stopPropagation(); toggleDigestExclude('${paper.id}', this)"
        title="${digestExcludedPapers.has(paper.id) ? 'Include in digest' : 'Exclude from digest'}">
        <span class="card-idx-num">${index + 1}</span>
        <span class="card-idx-action">${digestExcludedPapers.has(paper.id) ? 'Include' : 'Exclude'}</span>
      </button>
      ${paper.isMatched ? '<div class="match-badge" title="匹配您的搜索条件"></div>' : ''}
      <div class="paper-card-header">
        <h3 class="paper-card-title">${highlightedTitle}</h3>
        <p class="paper-card-authors">${formattedAuthors}</p>
        <div class="paper-card-categories">
          ${categoryTags}
        </div>
      </div>
      <div class="paper-card-body">
        <p class="paper-card-summary">${highlightedSummary}</p>
        ${paper.comment ? `<p class="paper-card-comment">${paper.comment}</p>` : ''}
        <div class="paper-card-footer">
          <div class="footer-left">
            <span class="paper-card-date">Crawled: ${formatDate(paper.date)}</span>
          </div>
          <span class="paper-card-link">Details</span>
        </div>
      </div>
    `;
    
    paperCard.addEventListener('click', () => {
      currentPaperIndex = index; // 记录当前点击的论文索引
      showPaperDetails(paper, index + 1);
    });
    
    container.appendChild(paperCard);
  });

  // First render with data: trigger daily digest check
  if (!window._dailyDigestChecked && Object.keys(paperData).length > 0) {
    window._dailyDigestChecked = true;
    setTimeout(checkAndShowDailyDigest, 500);
  }
}

async function generateAiContent() {
  const paper = currentFilteredPapers[currentPaperIndex];
  if (!paper) return;

  const apiKey = localStorage.getItem('aiApiKey');
  const baseUrl = (localStorage.getItem('aiBaseUrl') || 'https://api.openai.com/v1').replace(/\/$/, '');
  const modelName = localStorage.getItem('aiModelName') || 'gpt-4o-mini';

  const btn = document.getElementById('generateAiBtn');
  const errEl = document.getElementById('aiGenerateError');
  errEl.textContent = '';

  if (!apiKey) {
    showConfigRequiredModal('ai');
    return;
  }

  btn.textContent = 'Generating...';
  btn.disabled = true;

  const promptSuffix = localStorage.getItem('aiPromptSuffix') || '';
  const prompt = `Analyze the following research paper abstract. Respond with a JSON object containing exactly these fields:
"tldr": one concise sentence summarizing the paper
"motivation": why this research was needed / what problem it solves
"method": key technical approach or methodology
"result": main results or findings
"conclusion": broader impact or takeaway
${promptSuffix ? `\nAdditional instructions: ${promptSuffix}` : ''}
Abstract:
${paper.details}

Return valid JSON only, no markdown, no extra text.`;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const aiText = data.choices[0].message.content;
    let aiData;
    try {
      aiData = JSON.parse(aiText);
    } catch {
      const match = aiText.match(/\{[\s\S]*\}/);
      if (match) aiData = JSON.parse(match[0]);
      else throw new Error('Could not parse AI response as JSON');
    }

    paper.summary    = aiData.tldr       || '';
    paper.motivation = aiData.motivation || '';
    paper.method     = aiData.method     || '';
    paper.result     = aiData.result     || '';
    paper.conclusion = aiData.conclusion || '';

    showPaperDetails(paper, currentPaperIndex + 1);

    // Persist to data file in the background (visitors without a GitHub token can't save)
    if (localStorage.getItem('githubToken')) {
      const saveEl = document.getElementById('aiSaveStatus');
      if (saveEl) { saveEl.textContent = 'Saving to data file…'; saveEl.className = 'ai-save-status saving'; }
      writeAiToDataFile(paper)
        .then(() => {
          const el = document.getElementById('aiSaveStatus');
          if (el) { el.textContent = '✓ Saved to data file'; el.className = 'ai-save-status saved'; }
        })
        .catch(e => {
          console.warn('writeAiToDataFile:', e);
          const el = document.getElementById('aiSaveStatus');
          if (el) { el.textContent = `Save failed: ${e.message}`; el.className = 'ai-save-status save-error'; }
        });
    } else {
      showConfigRequiredModal('save');
    }
  } catch (e) {
    btn.textContent = 'Retry Generate';
    btn.disabled = false;
    errEl.textContent = `Error: ${e.message}`;
    console.error('AI generation failed:', e);
  }
}

async function writeAiToDataFile(paper) {
  const token = localStorage.getItem('githubToken');
  if (!token) return;

  // Only plain-date files are writable this way (legacy AI-enhanced files are read-only)
  if (!window.plainDates?.has(currentDate)) return;

  const { repoOwner, repoName, dataBranch } = DATA_CONFIG;
  const filePath = `data/${currentDate}.jsonl`;
  const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };

  // Fetch current file to get content + SHA
  const getRes = await fetch(`${apiUrl}?ref=${dataBranch}`, { headers, cache: 'no-store' });
  if (!getRes.ok) throw new Error(`GitHub GET ${getRes.status}: ${await getRes.text()}`);
  const fileData = await getRes.json();

  // Decode base64 content, patch the matching line
  const raw = new TextDecoder().decode(
    Uint8Array.from(atob(fileData.content.replace(/\n/g, '')), c => c.charCodeAt(0))
  );
  const lines = raw.split('\n').filter(l => l.trim());
  let matched = false;
  const patched = lines.map(line => {
    try {
      const obj = JSON.parse(line);
      if (obj.id === paper.id) {
        matched = true;
        obj.AI = {
          tldr:       paper.summary,
          motivation: paper.motivation,
          method:     paper.method,
          result:     paper.result,
          conclusion: paper.conclusion
        };
      }
      return JSON.stringify(obj);
    } catch { return line; }
  });
  if (!matched) throw new Error(`Paper id "${paper.id}" not found in ${filePath}`);
  const encoded = new TextEncoder().encode(patched.join('\n') + '\n');
  let binary = '';
  for (let i = 0; i < encoded.length; i++) binary += String.fromCharCode(encoded[i]);
  const newContent = btoa(binary);

  // Write back
  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: `AI: generated content for ${paper.id}`,
      content: newContent,
      sha: fileData.sha,
      branch: dataBranch
    })
  });
  if (!putRes.ok) throw new Error(`GitHub PUT ${putRes.status}: ${await putRes.text()}`);
}

function togglePromptSuffix() {
  const area = document.getElementById('promptSuffixArea');
  if (area) area.style.display = area.style.display === 'none' ? 'block' : 'none';
}

function savePromptSuffix() {
  const val = document.getElementById('promptSuffixInput')?.value || '';
  localStorage.setItem('aiPromptSuffix', val);
  togglePromptSuffix();
}

function showPaperDetails(paper, paperIndex) {
  const modal = document.getElementById('paperModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const paperLink = document.getElementById('paperLink');
  const pdfLink = document.getElementById('pdfLink');
  const htmlLink = document.getElementById('htmlLink');
  
  // 重置模态框的滚动位置
  modalBody.scrollTop = 0;
  
  // Combine topic selected words + text search for highlighting
  const allModalTerms = [...getAllSelectedTopicWords()];
  if (textSearchQuery && textSearchQuery.trim().length > 0) allModalTerms.push(textSearchQuery.trim());

  function applyHighlights(text) {
    if (!text) return text;
    return allModalTerms.length > 0 ? highlightMatches(text, allModalTerms, 'keyword-highlight') : text;
  }

  // 高亮标题
  const highlightedTitle = applyHighlights(paper.title);

  // 在标题前添加索引号
  const isExcluded = digestExcludedPapers.has(paper.id);
  modalTitle.innerHTML = paperIndex
    ? `<button class="paper-index-badge ${isExcluded ? 'excluded' : ''}" data-pid="${paper.id}" onclick="toggleDigestExcludeFromModal('${paper.id}')" title="${isExcluded ? 'Include in digest' : 'Exclude from digest'}">${paperIndex}</button> ${highlightedTitle}`
    : highlightedTitle;

  const abstractText = paper.details || '';

  const categoryDisplay = paper.allCategories ?
    paper.allCategories.join(', ') :
    paper.category;

  // 高亮作者（文本搜索）
  const highlightedAuthors = textSearchQuery
    ? highlightMatches(paper.authors, [textSearchQuery.trim()], 'author-highlight')
    : paper.authors;

  const highlightedSummary   = applyHighlights(paper.summary);
  const highlightedAbstract  = applyHighlights(abstractText);
  const highlightedMotivation = applyHighlights(paper.motivation);
  const highlightedMethod     = applyHighlights(paper.method);
  const highlightedResult     = applyHighlights(paper.result);
  const highlightedConclusion = applyHighlights(paper.conclusion);

  const showHighlightLegend = false;
  
  // 添加匹配标记
  const matchedPaperClass = paper.isMatched ? 'matched-paper-details' : '';
  
  const modalContent = `
    <div class="paper-details ${matchedPaperClass}">
      <p><strong>Authors: </strong>${highlightedAuthors}</p>
      <p><strong>Categories: </strong>${categoryDisplay}</p>
      <p><strong>Date: </strong>${formatDate(paper.date)}</p>
      ${paper.published ? `<p><strong>Submitted: </strong>${new Date(paper.published).toUTCString().replace(' GMT', ' UTC')}</p>` : ''}
      ${paper.comment ? `<p><strong>Comment: </strong><span class="paper-comment">${paper.comment}</span></p>` : ''}

      <div class="ai-section">
        ${paper.summary ? `<h3>TL;DR</h3><p>${highlightedSummary}</p>` : ''}
        <div class="paper-sections">
          ${paper.motivation ? `<div class="paper-section"><h4>Motivation</h4><p>${highlightedMotivation}</p></div>` : ''}
          ${paper.method ? `<div class="paper-section"><h4>Method</h4><p>${highlightedMethod}</p></div>` : ''}
          ${paper.result ? `<div class="paper-section"><h4>Result</h4><p>${highlightedResult}</p></div>` : ''}
          ${paper.conclusion ? `<div class="paper-section"><h4>Conclusion</h4><p>${highlightedConclusion}</p></div>` : ''}
        </div>
        <div class="ai-controls">
          <button id="generateAiBtn" class="button primary ai-generate-btn" onclick="generateAiContent()">
            ${paper.summary ? 'Regenerate' : 'Generate AI Analysis'}
          </button>
          <button class="button ai-prompt-edit-btn" onclick="togglePromptSuffix()" title="Customize prompt">Edit prompt</button>
        </div>
        <div id="promptSuffixArea" class="prompt-suffix-area" style="display:none;">
          <p class="prompt-suffix-hint">Base prompt is fixed. Add extra instructions below (e.g. "Explain the method in 300 words"):</p>
          <textarea id="promptSuffixInput" class="prompt-suffix-input" rows="3" placeholder="e.g. Use simple language suitable for a non-expert.">${localStorage.getItem('aiPromptSuffix') || ''}</textarea>
          <button class="button ai-prompt-save-btn" onclick="savePromptSuffix()">Save</button>
        </div>
        <p id="aiGenerateError" class="ai-generate-error"></p>
        <p id="aiSaveStatus" class="ai-save-status"></p>
      </div>
      
      ${highlightedAbstract ? `<h3>Abstract</h3><p class="original-abstract">${highlightedAbstract}</p>` : ''}
      
      <div class="pdf-preview-section">
        <div class="pdf-header">
          <h3>PDF Preview</h3>
          <button class="pdf-expand-btn" onclick="togglePdfSize(this)">
            <svg class="expand-icon" viewBox="0 0 24 24" width="24" height="24">
              <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
            </svg>
            <svg class="collapse-icon" viewBox="0 0 24 24" width="24" height="24" style="display: none;">
              <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>
            </svg>
          </button>
        </div>
        <div class="pdf-container">
          <iframe src="${paper.url.replace('abs', 'pdf')}" width="100%" height="800px" frameborder="0"></iframe>
        </div>
      </div>

    </div>
  `;
  
  // Update modal content
  document.getElementById('modalBody').innerHTML = modalContent;
  // Sync footer exclude button
  syncDigestExcludeFooterBtn(paper.id);
  document.getElementById('paperLink').href = paper.url;
  document.getElementById('pdfLink').href = paper.url.replace('abs', 'pdf');
  document.getElementById('htmlLink').href = paper.url.replace('abs', 'html');
  
  // --- GitHub Button Logic ---
  const githubLink = document.getElementById('githubLink');
  
  if (paper.code_url) {
    githubLink.href = paper.code_url;
    githubLink.style.display = 'flex'; 
    githubLink.title = "View Code on GitHub";
  } else {
    githubLink.style.display = 'none';
  }
  // ---------------------------

  // 提示词来自：https://papers.cool/
  prompt = `请你阅读这篇文章${paper.url.replace('abs', 'pdf')},总结一下这篇文章解决的问题、相关工作、研究方法、做了什么实验及其结果、结论，最后整体总结一下这篇文章的内容`
  document.getElementById('kimiChatLink').href = `https://www.kimi.com/_prefill_chat?prefill_prompt=${prompt}&system_prompt=你是一个学术助手，后面的对话将围绕着以下论文内容进行，已经通过链接给出了论文的PDF和论文已有的FAQ。用户将继续向你咨询论文的相关问题，请你作出专业的回答，不要出现第一人称，当涉及到分点回答时，鼓励你以markdown格式输出。&send_immediately=true&force_search=true`;
  
  // 更新论文位置信息
  const paperPosition = document.getElementById('paperPosition');
  if (paperPosition && currentFilteredPapers.length > 0) {
    paperPosition.textContent = `${currentPaperIndex + 1} / ${currentFilteredPapers.length}`;
  }
  
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  const modal = document.getElementById('paperModal');
  const modalBody = document.getElementById('modalBody');
  
  // 重置模态框的滚动位置
  modalBody.scrollTop = 0;
  
  modal.classList.remove('active');
  document.body.style.overflow = '';
}

// 导航到上一篇论文
function navigateToPreviousPaper() {
  if (currentFilteredPapers.length === 0) return;
  
  currentPaperIndex = currentPaperIndex > 0 ? currentPaperIndex - 1 : currentFilteredPapers.length - 1;
  const paper = currentFilteredPapers[currentPaperIndex];
  showPaperDetails(paper, currentPaperIndex + 1);
}

// 导航到下一篇论文
function navigateToNextPaper() {
  if (currentFilteredPapers.length === 0) return;
  
  currentPaperIndex = currentPaperIndex < currentFilteredPapers.length - 1 ? currentPaperIndex + 1 : 0;
  const paper = currentFilteredPapers[currentPaperIndex];
  showPaperDetails(paper, currentPaperIndex + 1);
}

// 显示随机论文
function showRandomPaper() {
  // 检查是否有可用的论文
  if (currentFilteredPapers.length === 0) {
    console.log('No papers available to show random paper');
    return;
  }
  
  // 生成随机索引
  const randomIndex = Math.floor(Math.random() * currentFilteredPapers.length);
  const randomPaper = currentFilteredPapers[randomIndex];
  
  // 更新当前论文索引
  currentPaperIndex = randomIndex;
  
  // 显示随机论文
  showPaperDetails(randomPaper, currentPaperIndex + 1);
  
  // 显示随机论文指示器
  showRandomPaperIndicator();
  
  console.log(`Showing random paper: ${randomIndex + 1}/${currentFilteredPapers.length}`);
}

// 显示随机论文指示器
function showRandomPaperIndicator() {
  // 移除已存在的指示器
  const existingIndicator = document.querySelector('.random-paper-indicator');
  if (existingIndicator) {
    existingIndicator.remove();
  }
  
  // 创建新的指示器
  const indicator = document.createElement('div');
  indicator.className = 'random-paper-indicator';
  indicator.textContent = 'Random Paper';
  
  // 添加到页面
  document.body.appendChild(indicator);
  
  // 3秒后自动移除
  setTimeout(() => {
    if (indicator && indicator.parentNode) {
      indicator.remove();
    }
  }, 3000);
}

function toggleDatePicker() {
  const datePicker = document.getElementById('datePickerModal');
  datePicker.classList.toggle('active');
  
  if (datePicker.classList.contains('active')) {
    document.body.style.overflow = 'hidden';
    
    // 重新初始化日期选择器以确保它反映最新的可用日期
    if (flatpickrInstance) {
      flatpickrInstance.setDate(currentDate, false);
    }
  } else {
    document.body.style.overflow = '';
  }
}

function toggleView() {
  currentView = currentView === 'grid' ? 'list' : 'grid';
  document.getElementById('paperContainer').classList.toggle('list-view', currentView === 'list');
}

function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  });
}

async function loadPapersByDates(dates) {
  if (dates.length === 1) {
    return loadPapersByDate(dates[0]);
  }

  currentDate = dates.join(',');
  const label = dates.length <= 3
    ? dates.map(formatDate).join(', ')
    : `${dates.length} dates`;
  document.getElementById('currentDate').textContent = label;

  const container = document.getElementById('paperContainer');
  container.innerHTML = `
    <div class="loading-container">
      <div class="loading-spinner"></div>
      <p>Loading papers from ${label}...</p>
    </div>
  `;

  try {
    const results = await Promise.all(
      dates.map(async date => {
        const res = await fetch(getDataUrlForDate(date), { cache: 'no-store' });
        if (!res.ok) return {};
        return parseJsonlData(await res.text(), date);
      })
    );

    const merged = {};
    results.forEach(data => {
      Object.keys(data).forEach(cat => {
        if (!merged[cat]) merged[cat] = [];
        merged[cat] = merged[cat].concat(data[cat]);
      });
    });

    paperData = merged;
    buildLunrIndex(paperData);
    renderCategoryFilter(getAllCategories(paperData));
    renderPapers();
  } catch (error) {
    container.innerHTML = `
      <div class="loading-container">
        <p>Loading failed: ${error.message}</p>
      </div>
    `;
  }
}

async function loadPapersByDateRange(startDate, endDate) {
  // 获取日期范围内的所有有效日期
  const validDatesInRange = availableDates.filter(date => {
    return date >= startDate && date <= endDate;
  });
  
  if (validDatesInRange.length === 0) {
    alert('No available papers in the selected date range.');
    return;
  }
  
  currentDate = `${startDate} to ${endDate}`;
  document.getElementById('currentDate').textContent = `${formatDate(startDate)} - ${formatDate(endDate)}`;
  
  // 不再重置激活的关键词和作者
  // 而是保持当前选择状态
  
  const container = document.getElementById('paperContainer');
  container.innerHTML = `
    <div class="loading-container">
      <div class="loading-spinner"></div>
      <p>Loading papers from ${formatDate(startDate)} to ${formatDate(endDate)}...</p>
    </div>
  `;
  
  try {
    // 加载所有日期的论文数据
    const allPaperData = {};
    
    for (const date of validDatesInRange) {
      const dataUrl = getDataUrlForDate(date);
      const response = await fetch(dataUrl);
      const text = await response.text();
      const dataPapers = parseJsonlData(text, date);
      
      // 合并数据
      Object.keys(dataPapers).forEach(category => {
        if (!allPaperData[category]) {
          allPaperData[category] = [];
        }
        allPaperData[category] = allPaperData[category].concat(dataPapers[category]);
      });
    }
    
    paperData = allPaperData;
    buildLunrIndex(paperData);

    const categories = getAllCategories(paperData);
    
    renderCategoryFilter(categories);
    
    renderPapers();
  } catch (error) {
    console.error('加载论文数据失败:', error);
    container.innerHTML = `
      <div class="loading-container">
        <p>Loading data fails. Please retry.</p>
        <p>Error messages: ${error.message}</p>
      </div>
    `;
  }
}

// 切换PDF预览器大小
function togglePdfSize(button) {
  const pdfContainer = button.closest('.pdf-preview-section').querySelector('.pdf-container');
  const iframe = pdfContainer.querySelector('iframe');
  const expandIcon = button.querySelector('.expand-icon');
  const collapseIcon = button.querySelector('.collapse-icon');
  
  if (pdfContainer.classList.contains('expanded')) {
    // 恢复正常大小
    pdfContainer.classList.remove('expanded');
    iframe.style.height = '800px';
    expandIcon.style.display = 'block';
    collapseIcon.style.display = 'none';
    
    // 移除遮罩层
    const overlay = document.querySelector('.pdf-overlay');
    if (overlay) {
      overlay.remove();
    }
  } else {
    // 放大显示
    pdfContainer.classList.add('expanded');
    iframe.style.height = '90vh';
    expandIcon.style.display = 'none';
    collapseIcon.style.display = 'block';
    
    // 添加遮罩层
    const overlay = document.createElement('div');
    overlay.className = 'pdf-overlay';
    document.body.appendChild(overlay);
    
    // 点击遮罩层时收起PDF
    overlay.addEventListener('click', () => {
      togglePdfSize(button);
    });
  }
}

// ── AI Digest ─────────────────────────────────────────────────────────────────

const DIGEST_FIXED_PROMPT = `You are a research journalist writing for an AI/ML research community. Given a list of papers, produce a comprehensive, detailed technical digest.

Output format (strict markdown):
1. First line: # [Your generated title — a specific, descriptive headline for this digest]
2. ## Executive Summary — A paragraph of 5–7 sentences covering the day's major research themes, their significance, and the overall landscape.
3. 4–5 thematic ## sections (choose titles that reflect the actual content). Each section must discuss multiple related papers in depth: explain the problem addressed, the proposed method and key technical details (architecture, algorithm, dataset, metrics), and notable results. Cite papers inline as [1], [2], etc. Use **bold** for key terms, model names, and metrics.
4. ## Key Takeaways — 5–7 bullet points of the most important results, emerging trends, and implications for the field.

Requirements:
- Walk through EVERY paper — each must be discussed substantively (at least 3–4 sentences) and cited at least once.
- Be technical and specific: include architectures, loss functions, benchmark names, and numbers when available.
- Group papers thematically across sections, not in the order listed.
- Minimum length: thorough coverage of all papers with no padding.`;

function formatAuthorsShort(authors) {
  if (!authors) return '';
  const parts = authors.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length <= 2) return parts.join(', ');
  return `${parts[0]}, ${parts[1]} et al.`;
}

function updateDigestNavBtn() {
  const btn = document.getElementById('digestNavBtn');
  if (!btn) return;
  btn.dataset.state = digestView;
  if (digestView === 'generating') {
    btn.innerHTML = `<span class="digest-nav-spinner"></span><span class="digest-nav-label">Generating…</span>`;
  } else if (digestView === 'result') {
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg><span class="digest-nav-label">Digest Ready</span>`;
  } else {
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg><span class="digest-nav-label">AI Digest</span>`;
  }
}

function openDigestModal() {
  const modal = document.getElementById('digestModal');
  if (!modal) return;
  renderDigestModalContent();
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeDigestModal() {
  const modal = document.getElementById('digestModal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}

function renderDigestModalContent() {
  const content = document.getElementById('digestModalContent');
  if (!content) return;

  const closeSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`;

  if (digestView === 'generating') {
    content.innerHTML = `
      <div class="digest-modal-header">
        <div>
          <h2 class="digest-modal-title">AI Research Digest</h2>
          <p class="digest-modal-subtitle">Generating for ${digestState.selectedPapers.length} papers…</p>
        </div>
        <button class="digest-close-btn" onclick="closeDigestModal()">${closeSvg}</button>
      </div>
      <div class="digest-modal-body digest-generating-body">
        <div class="digest-loading">
          <div class="loading-spinner"></div>
          <p class="digest-loading-label">Generating digest…</p>
          <p class="digest-loading-hint">This may take a minute for large sets of papers.</p>
        </div>
      </div>`;
    return;
  }

  if (digestView === 'result') {
    content.innerHTML = `
      <div class="digest-modal-header">
        <div class="digest-title-row">
          <h1 id="digestTitleDisplay" class="digest-title-display">${escapeHtml(digestState.title)}</h1>
          <button class="digest-rename-btn" onclick="renameDigestTitle()" title="Rename">&#9998;</button>
        </div>
        <button class="digest-close-btn" onclick="closeDigestModal()">${closeSvg}</button>
      </div>
      <div class="digest-modal-body">
        <div class="digest-article">${digestState.html}</div>
        <div class="digest-references">
          <h3>References</h3>
          <ol>${digestState.refHtml}</ol>
        </div>
      </div>
      <div class="digest-result-footer">
        <button class="button digest-edit-btn" onclick="showDigestSetup()">&#8592; Edit Selection</button>
        <div class="digest-result-footer-right">
          <button id="digestSaveBtn" class="button primary" onclick="saveCurrentDigest()">Save Digest</button>
          <button class="button digest-copy-btn" onclick="copyDigest()">Copy</button>
        </div>
      </div>`;
    return;
  }

  // setup view
  const selected = currentFilteredPapers.filter(p => !digestExcludedPapers.has(p.id));
  const userPromptVal = localStorage.getItem('digestUserPrompt') || '';
  const hasResult = !!digestState.markdown;
  content.innerHTML = `
    <div class="digest-modal-header">
      <div>
        <h2 class="digest-modal-title">AI Research Digest</h2>
        <p class="digest-modal-subtitle" id="digestSubtitle">${selected.length} of ${currentFilteredPapers.length} papers selected</p>
      </div>
      <button class="digest-close-btn" onclick="closeDigestModal()">${closeSvg}</button>
    </div>
    <div class="digest-modal-body">
      <div class="digest-section">
        <div class="digest-section-head">
          <span class="digest-sec-label">Papers</span>
          <span class="digest-count" id="digestCount">${selected.length} selected</span>
        </div>
        <div id="digestPapersGrid" class="digest-papers-grid">
          ${renderDigestPaperCards()}
        </div>
      </div>
      <div class="digest-section">
        <div class="digest-sec-label">Base Prompt <span class="digest-prompt-note">(fixed)</span></div>
        <pre class="digest-prompt-fixed">${DIGEST_FIXED_PROMPT}</pre>
        <div class="digest-sec-label" style="margin-top:12px;">Additional Instructions <span class="digest-prompt-note">(optional)</span></div>
        <textarea id="digestUserPrompt" class="digest-user-prompt" rows="3"
          placeholder="e.g. Focus on practical applications. Keep it concise."
          oninput="localStorage.setItem('digestUserPrompt', this.value)">${userPromptVal}</textarea>
      </div>
      <div class="digest-actions">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <button id="digestGenerateBtn" class="button primary digest-generate-btn" onclick="generateDigest()">
            ✦ ${hasResult ? 'Regenerate Digest' : 'Generate Digest'}
          </button>
          ${hasResult ? `<button class="button" onclick="showDigestResult()">View Last Digest</button>` : ''}
        </div>
        <p id="digestError" class="digest-error"></p>
      </div>
    </div>`;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Saved Digests panel ────────────────────────────────────────────────────────

function openDigestsPanel() {
  const panel = document.getElementById('digestsPanel');
  if (!panel) return;
  renderDigestsPanel();
  panel.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeDigestsPanel() {
  const panel = document.getElementById('digestsPanel');
  if (panel) panel.style.display = 'none';
  document.body.style.overflow = '';
}

function digestPlainPreview(md, maxLen) {
  // Strip markdown and extract plain text preview
  const plain = md
    .replace(/^#+ .+$/gm, '')        // headings
    .replace(/\*\*(.+?)\*\*/g, '$1') // bold
    .replace(/\*(.+?)\*/g, '$1')     // italic
    .replace(/\[(\d+)\]/g, '')       // citations
    .replace(/^[\*\-] /gm, '')       // bullets
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
  return plain.length > maxLen ? plain.slice(0, maxLen).replace(/\s\S+$/, '') + '…' : plain;
}

function renderDigestsPanel() {
  const list = document.getElementById('digestsPanelList');
  const countEl = document.getElementById('digestsPanelCount');
  if (!list) return;

  const digests = JSON.parse(localStorage.getItem('savedDigests') || '[]');
  if (countEl) countEl.textContent = digests.length === 0 ? '' : `${digests.length} digest${digests.length !== 1 ? 's' : ''}`;

  if (digests.length === 0) {
    list.innerHTML = `
      <div class="digests-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 12h6M9 16h6M7 4H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2h-2M7 4a2 2 0 012-2h6a2 2 0 012 2M7 4a2 2 0 000 4h10a2 2 0 000-4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <p class="digests-empty-title">No saved digests yet</p>
        <p class="digests-empty-sub">Generate an AI digest and save it here.</p>
      </div>`;
    return;
  }

  list.innerHTML = digests.map((digest, index) => {
    const papers = digest.papers || [];
    const bodyMd = (digest.digest || '').replace(/^#\s+.+\n?\n?/, '');
    const preview = digestPlainPreview(bodyMd, 160);
    const ts = new Date(digest.timestamp).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
    return `
      <div class="digest-compact-card" onclick="openDigestViewModal(${index})">
        <div class="digest-compact-meta">
          <span class="digest-entry-time">${ts}</span>
          <span class="digest-entry-badge">${papers.length} papers</span>
        </div>
        <h3 class="digest-compact-title">${escapeHtml(digest.title || 'Research Digest')}</h3>
        <p class="digest-compact-preview">${escapeHtml(preview)}</p>
      </div>`;
  }).join('');
}

let digestViewIndex = 0;

function openDigestViewModal(index) {
  digestViewIndex = index;
  renderDigestViewModal();
  document.getElementById('digestViewModal').style.display = 'flex';
}

function renderDigestViewModal() {
  const digests = JSON.parse(localStorage.getItem('savedDigests') || '[]');
  const index = digestViewIndex;
  const digest = digests[index];
  if (!digest) return;

  const papers = digest.papers || [];
  const bodyMd = (digest.digest || '').replace(/^#\s+.+\n?\n?/, '');
  const articleHtml = digestMarkdownToHtml(bodyMd);
  const refsHtml = papers.map((p, i) =>
    `<li><a href="${escapeHtml(p.url || '#')}" target="_blank" rel="noopener">${escapeHtml(p.title || '')}</a><br>
     <span class="digest-ref-meta">${escapeHtml(formatAuthorsShort(p.authors))} · ${formatDate(p.date)}</span></li>`
  ).join('');
  const ts = new Date(digest.timestamp).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const hasPrev = index > 0;
  const hasNext = index < digests.length - 1;

  document.getElementById('digestViewContent').innerHTML = `
    <div class="digest-view-header">
      <div class="digest-view-header-left">
        <p class="digest-view-meta">${ts} · ${papers.length} papers · ${index + 1} / ${digests.length}</p>
        <h1 class="digest-view-title">${escapeHtml(digest.title || 'Research Digest')}</h1>
      </div>
      <button class="digest-close-btn" onclick="closeDigestViewModal()">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="digest-view-body">
      <div class="digest-article">${articleHtml}</div>
      ${refsHtml ? `<div class="digest-references"><h3>References</h3><ol>${refsHtml}</ol></div>` : ''}
    </div>
    <div class="digest-view-footer">
      <button class="button digest-entry-delete-btn" onclick="deletePanelDigest(${index}); closeDigestViewModal();">Delete</button>
      <div class="digest-view-nav">
        <button class="button digest-view-nav-btn" onclick="navigateDigestView(-1)" ${!hasPrev ? 'disabled' : ''} title="Previous (←)">&#8592; Prev</button>
        <button class="button digest-view-nav-btn" onclick="navigateDigestView(1)" ${!hasNext ? 'disabled' : ''} title="Next (→)">Next &#8594;</button>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="button" onclick="copyPanelDigest(${index})" id="digestViewCopyBtn">Copy</button>
        <button class="button primary" onclick="closeDigestViewModal()">Close</button>
      </div>
    </div>`;

  // Scroll body back to top on navigation
  const body = document.querySelector('#digestViewContent .digest-view-body');
  if (body) body.scrollTop = 0;
}

function navigateDigestView(delta) {
  const digests = JSON.parse(localStorage.getItem('savedDigests') || '[]');
  const next = digestViewIndex + delta;
  if (next >= 0 && next < digests.length) {
    digestViewIndex = next;
    renderDigestViewModal();
  }
}

function closeDigestViewModal() {
  const modal = document.getElementById('digestViewModal');
  if (modal) modal.style.display = 'none';
}

// Keyboard navigation for digest view modal
document.addEventListener('keydown', e => {
  const modal = document.getElementById('digestViewModal');
  if (!modal || modal.style.display === 'none') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); navigateDigestView(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); navigateDigestView(1); }
  if (e.key === 'Escape') closeDigestViewModal();
});

function deletePanelDigest(index) {
  if (!confirm('Delete this digest? This cannot be undone.')) return;
  const digests = JSON.parse(localStorage.getItem('savedDigests') || '[]');
  digests.splice(index, 1);
  localStorage.setItem('savedDigests', JSON.stringify(digests));
  renderDigestsPanel();
}

function copyPanelDigest(index) {
  const digests = JSON.parse(localStorage.getItem('savedDigests') || '[]');
  const digest = digests[index];
  if (!digest) return;
  navigator.clipboard.writeText(digest.digest || '').then(() => {
    const btn = document.getElementById('digestViewCopyBtn') ||
      document.querySelector(`.digest-entry[data-index="${index}"] .digest-entry-copy-btn`);
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 2000); }
  });
}

function showDigestSetup() {
  digestView = 'setup';
  persistDigestState();
  renderDigestModalContent();
  updateDigestNavBtn();
}

function showDigestResult() {
  digestView = 'result';
  persistDigestState();
  renderDigestModalContent();
  updateDigestNavBtn();
}

function renameDigestTitle() {
  const el = document.getElementById('digestTitleDisplay');
  if (!el) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'digest-title-input';
  input.value = digestState.title;
  el.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const val = input.value.trim();
    if (val) digestState.title = val;
    const newEl = document.createElement('h1');
    newEl.id = 'digestTitleDisplay';
    newEl.className = 'digest-title-display';
    newEl.textContent = digestState.title;
    input.replaceWith(newEl);
    // Re-enable save button since title changed
    const saveBtn = document.getElementById('digestSaveBtn');
    if (saveBtn && saveBtn.disabled) {
      saveBtn.textContent = 'Save Digest';
      saveBtn.disabled = false;
    }
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = digestState.title; input.blur(); }
  });
}

function saveCurrentDigest() {
  if (!digestState.markdown) return;
  saveDigest(digestState.markdown, digestState.selectedPapers, digestState.title);
  const btn = document.getElementById('digestSaveBtn');
  if (btn) { btn.textContent = 'Saved ✓'; btn.disabled = true; }
}

const DIGEST_INITIAL_SHOW = 12;

function renderDigestPaperCards() {
  const all = currentFilteredPapers;
  const selectedPapers = all.filter(p => !digestExcludedPapers.has(p.id));
  let refNum = 0;

  const cardHtml = all.map(p => {
    const excluded = digestExcludedPapers.has(p.id);
    if (!excluded) refNum++;
    const ref = excluded ? '' : `[${refNum}]`;
    return `<div class="digest-paper-card ${excluded ? 'deselected' : ''}" data-pid="${p.id}" onclick="toggleDigestPaperInModal('${p.id}')">
      <span class="digest-ref-num">${ref}</span>
      <div class="digest-paper-info">
        <span class="digest-paper-title">${p.title}</span>
        <span class="digest-paper-meta">${formatAuthorsShort(p.authors)} · ${formatDate(p.date)}</span>
      </div>
      <span class="digest-check">${excluded ? '' : '✓'}</span>
    </div>`;
  });

  const visible = cardHtml.slice(0, DIGEST_INITIAL_SHOW).join('');
  const rest = cardHtml.slice(DIGEST_INITIAL_SHOW);
  const hasMore = rest.length > 0;

  return `${visible}
    ${hasMore ? `
      <div id="digestHiddenCards" style="display:none;">${rest.join('')}</div>
      <button class="digest-expand-btn" id="digestExpandBtn" onclick="toggleDigestPapersExpand()">
        Show all ${all.length} papers ▾
      </button>` : ''}`;
}

function toggleDigestPaperInModal(paperId) {
  if (digestExcludedPapers.has(paperId)) {
    digestExcludedPapers.delete(paperId);
  } else {
    digestExcludedPapers.add(paperId);
  }
  // Re-render paper cards, preserving expanded state
  const grid = document.getElementById('digestPapersGrid');
  if (grid) {
    const wasExpanded = document.getElementById('digestHiddenCards')?.style.display !== 'none';
    grid.innerHTML = renderDigestPaperCards();
    if (wasExpanded) {
      const hidden = document.getElementById('digestHiddenCards');
      const btn = document.getElementById('digestExpandBtn');
      if (hidden) hidden.style.display = 'contents';
      if (btn) btn.textContent = 'Show fewer ▴';
    }
  }
  const selected = currentFilteredPapers.filter(p => !digestExcludedPapers.has(p.id));
  const countEl = document.getElementById('digestCount');
  if (countEl) countEl.textContent = `${selected.length} selected`;
  const subtitleEl = document.getElementById('digestSubtitle');
  if (subtitleEl) subtitleEl.textContent = `${selected.length} of ${currentFilteredPapers.length} papers selected`;
  updateDigestBadges();
}

function toggleDigestPapersExpand() {
  const hidden = document.getElementById('digestHiddenCards');
  const btn = document.getElementById('digestExpandBtn');
  if (!hidden || !btn) return;
  const expanded = hidden.style.display !== 'none';
  hidden.style.display = expanded ? 'none' : 'contents';
  btn.textContent = expanded
    ? `Show all ${currentFilteredPapers.length} papers ▾`
    : 'Show fewer ▴';
}

async function generateDigest() {
  const apiKey = localStorage.getItem('aiApiKey');
  const baseUrl = (localStorage.getItem('aiBaseUrl') || 'https://api.openai.com/v1').replace(/\/$/, '');
  const modelName = localStorage.getItem('aiModelName') || 'gpt-4o-mini';

  const errEl = document.getElementById('digestError');
  if (!apiKey) { showConfigRequiredModal('ai'); return; }

  const selected = currentFilteredPapers.filter(p => !digestExcludedPapers.has(p.id));
  if (selected.length === 0) { if (errEl) errEl.textContent = 'No papers selected.'; return; }

  const userAddition = (document.getElementById('digestUserPrompt')?.value || '').trim();
  const papersList = selected.map((p, i) =>
    `[${i + 1}] Title: "${p.title}"\nAuthors: ${p.authors}\n${p.summary ? `Abstract: ${p.summary}` : `Abstract: ${(p.details || '').slice(0, 600)}`}`
  ).join('\n\n');
  const fullPrompt = `${DIGEST_FIXED_PROMPT}${userAddition ? `\n\nAdditional instructions: ${userAddition}` : ''}\n\n---\n\nPapers:\n\n${papersList}`;

  // Switch to generating view
  digestState.selectedPapers = selected;
  digestView = 'generating';
  persistDigestState();
  renderDigestModalContent();
  updateDigestNavBtn();

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelName, messages: [{ role: 'user', content: fullPrompt }], max_tokens: 8000 })
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const mdText = data.choices[0].message.content;
    lastDigestMarkdown = mdText;

    // Extract title from first # line
    const titleMatch = mdText.match(/^#\s+(.+)/m);
    digestState.title = titleMatch ? titleMatch[1].trim() : 'Research Digest';
    // Strip title line from body
    const bodyMd = mdText.replace(/^#\s+.+\n?\n?/, '');
    digestState.markdown = mdText;
    digestState.html = digestMarkdownToHtml(bodyMd);
    digestState.refHtml = selected.map((p, i) =>
      `<li id="ref-${i+1}"><a href="${p.url}" target="_blank" rel="noopener">${p.title}</a><br>
       <span class="digest-ref-meta">${formatAuthorsShort(p.authors)} · Crawled ${formatDate(p.date)}</span></li>`
    ).join('');

    digestView = 'result';
    persistDigestState();
    updateDigestNavBtn();
    const modal = document.getElementById('digestModal');
    if (modal && modal.style.display !== 'none') renderDigestModalContent();
  } catch (e) {
    digestView = 'setup';
    persistDigestState();
    updateDigestNavBtn();
    const modal = document.getElementById('digestModal');
    if (modal && modal.style.display !== 'none') {
      renderDigestModalContent();
      const errElAfter = document.getElementById('digestError');
      if (errElAfter) errElAfter.textContent = `Error: ${e.message}`;
    }
  }
}

function digestMarkdownToHtml(md) {
  let html = md
    // Headings
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Citation superscripts [n]
    .replace(/\[(\d+)\]/g, '<sup class="cite">[<a href="#ref-$1">$1</a>]</sup>')
    // Bullet lists
    .replace(/^[\*\-] (.+)$/gm, '<li>$1</li>')
    // Split into blocks
    .split(/\n{2,}/);

  html = html.map(block => {
    const t = block.trim();
    if (!t) return '';
    if (/^<h[1-3]>/.test(t)) return t;
    if (/^<li>/.test(t)) return `<ul>${t}</ul>`;
    return `<p>${t.replace(/\n/g, ' ')}</p>`;
  });

  return html.join('\n');
}

function saveDigest(text, papers, title) {
  const saved = JSON.parse(localStorage.getItem('savedDigests') || '[]');
  saved.unshift({
    id: Date.now(),
    title: title || 'Research Digest',
    timestamp: new Date().toISOString(),
    digest: text,
    papers: papers.map(p => ({ title: p.title, url: p.url, authors: p.authors, date: p.date, id: p.id }))
  });
  if (saved.length > 20) saved.length = 20;
  localStorage.setItem('savedDigests', JSON.stringify(saved));
}

function copyDigest() {
  navigator.clipboard.writeText(lastDigestMarkdown).then(() => {
    const btn = document.querySelector('.digest-copy-btn');
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 2000); }
  });
}

function toggleDigestExclude(paperId, el) {
  if (!el) return;
  if (digestExcludedPapers.has(paperId)) {
    digestExcludedPapers.delete(paperId);
    el.classList.remove('excluded');
    el.querySelector('.card-idx-action').textContent = 'Exclude';
    el.title = 'Exclude from digest';
  } else {
    digestExcludedPapers.add(paperId);
    el.classList.add('excluded');
    el.querySelector('.card-idx-action').textContent = 'Include';
    el.title = 'Include in digest';
  }
  persistDigestState();
}

function toggleDigestExcludeFromModal(paperId) {
  if (!paperId) return;
  if (digestExcludedPapers.has(paperId)) {
    digestExcludedPapers.delete(paperId);
  } else {
    digestExcludedPapers.add(paperId);
  }
  persistDigestState();
  updateDigestBadges();
  syncDigestExcludeFooterBtn(paperId);
}

function syncDigestExcludeFooterBtn(paperId) {
  const exc = digestExcludedPapers.has(paperId);
  const btn = document.getElementById('digestExcludeFooterBtn');
  if (btn) {
    btn.textContent = exc ? '↩ Include in Digest' : '✕ Exclude from Digest';
    btn.classList.toggle('excluded', exc);
    btn.onclick = () => toggleDigestExcludeFromModal(paperId);
  }
  // Sync the title badge in the modal
  const badge = document.querySelector(`.paper-index-badge[data-pid="${paperId}"]`);
  if (badge) {
    badge.classList.toggle('excluded', exc);
    badge.title = exc ? 'Include in digest' : 'Exclude from digest';
  }
}

function updateDigestBadges() {
  document.querySelectorAll('.paper-card-index[data-pid]').forEach(badge => {
    const pid = badge.dataset.pid;
    const exc = digestExcludedPapers.has(pid);
    badge.classList.toggle('excluded', exc);
    const action = badge.querySelector('.card-idx-action');
    if (action) action.textContent = exc ? 'Include' : 'Exclude';
    badge.title = exc ? 'Include in digest' : 'Exclude from digest';
  });
}

// ── Topic Subscriptions & Daily Digest ───────────────────────────────────────

let _dailyDigests = null; // null=not fetched, []=empty, [...]=content
let _dailyDigestIdx = 0;
let _dailyDigestFetching = false;
let _manageSubs = [];
let _managePendingTopics = [];
let _manageActiveTopicForWords = null;
let _manageWordData = new Map();
let _manageNewTopicData = null;
let _manageNewTopicWords = new Set();
let _manageTopicInputValue = '';
let _manageInputTimer = null;

function openDailyDigestModal() {
  const modal = document.getElementById('dailyDigestModal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  if (_dailyDigests === null && !_dailyDigestFetching) {
    _renderDailyDigestLoading();
    _fetchDailyDigests().then(() => _renderDailyDigestModal());
  } else {
    _renderDailyDigestModal();
  }
}

function closeDailyDigestModal() {
  const modal = document.getElementById('dailyDigestModal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}

async function _fetchDailyDigests() {
  _dailyDigestFetching = true;
  const subs = JSON.parse(localStorage.getItem('topicSubscriptions') || '[]');
  const subMap = new Map(subs.map(s => [s.topic, s.words || []]));
  const { repoOwner, repoName, dataBranch } = DATA_CONFIG;

  // Try today and up to 6 previous days to find the most recent digest file
  let all = null;
  for (let daysBack = 0; daysBack <= 6; daysBack++) {
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    const dateStr = d.toLocaleDateString('en-CA');
    const url = `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${dataBranch}/daily-digests/${dateStr}.json`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) { all = await res.json(); break; }
    } catch (_) {}
  }

  if (!all) { _dailyDigests = []; _dailyDigestFetching = false; return; }

  // Filter to subscribed topics; if no match (or no subscriptions), show all
  if (subMap.size > 0) {
    const matched = all.filter(d => subMap.has(d.topic)).map(d => ({ ...d, words: subMap.get(d.topic) }));
    _dailyDigests = matched.length > 0 ? matched : all.map(d => ({ ...d, words: [] }));
  } else {
    _dailyDigests = all.map(d => ({ ...d, words: [] }));
  }
  _dailyDigestFetching = false;
}

function _buildSubTopicData(topic, papers, savedWordsList) {
  let words = [];
  if (lunrIndex) {
    try {
      const results = lunrIndex.search(topic);
      const matchedIds = new Set(results.map(r => r.ref));
      const allStems = new Set();
      results.forEach(r => Object.keys(r.matchData.metadata).forEach(s => allStems.add(s)));
      const matchedPapers = papers.filter(p => matchedIds.has(p.id));
      const wordCounts = new Map();
      matchedPapers.forEach(p => {
        const text = [p.title, p.summary, p.details, p.motivation, p.method, p.result, p.conclusion]
          .filter(Boolean).join(' ');
        const wordsInPaper = new Set();
        allStems.forEach(stem => {
          const re = new RegExp(`\\b(${stem}\\w*)`, 'gi');
          let m;
          while ((m = re.exec(text)) !== null) wordsInPaper.add(m[1].toLowerCase());
        });
        wordsInPaper.forEach(w => wordCounts.set(w, (wordCounts.get(w) || 0) + 1));
      });
      words = [...wordCounts.entries()]
        .map(([word, count]) => ({ word, count }))
        .sort((a, b) => b.count - a.count);
    } catch (_) {}
  }
  let selectedWords;
  if (savedWordsList && savedWordsList.length > 0) {
    const saved = new Set(savedWordsList);
    selectedWords = new Set(words.filter(w => saved.has(w.word)).map(w => w.word));
  } else {
    const topicTerms = new Set(topic.toLowerCase().split(/\s+/).filter(Boolean));
    selectedWords = new Set(words.filter(w => topicTerms.has(w.word)).map(w => w.word));
  }
  return { words, selectedWords };
}

function _renderDailyDigestLoading() {
  const content = document.getElementById('dailyDigestModalContent');
  if (!content) return;
  const closeBtn = `<button class="digest-close-btn" onclick="closeDailyDigestModal()"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></button>`;
  content.innerHTML = `
    <div class="daily-digest-header"><div class="daily-digest-label">Daily Digest</div>${closeBtn}</div>
    <div class="daily-digest-body daily-digest-empty"><div class="digest-loading"><div class="digest-spinner-ring"></div><p style="margin:12px 0 0;color:var(--text-secondary)">Loading digest…</p></div></div>`;
}

function _renderDailyDigestModal() {
  const content = document.getElementById('dailyDigestModalContent');
  if (!content) return;

  const subs = JSON.parse(localStorage.getItem('topicSubscriptions') || '[]');
  const today = new Date().toLocaleDateString('en-CA');
  const formattedDate = new Date(today + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const closeBtn = `<button class="digest-close-btn" onclick="closeDailyDigestModal()"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></button>`;
  const manageBtn = `<button class="button daily-manage-btn" onclick="openManageSubModal()">Manage subscriptions</button>`;

  if (!subs.length) {
    content.innerHTML = `
      <div class="daily-digest-header"><div class="daily-digest-label">Daily Digest</div>${closeBtn}</div>
      <div class="daily-digest-body daily-digest-empty"><p style="margin:0 0 16px">No topics subscribed yet.</p>${manageBtn}</div>`;
    return;
  }

  if (!_dailyDigests?.length) {
    const topicList = subs.map(s => s.topic).join(', ');
    content.innerHTML = `
      <div class="daily-digest-header"><div class="daily-digest-title-area"><div class="daily-digest-label">Daily Digest · ${formattedDate}</div></div>${closeBtn}</div>
      <div class="daily-digest-body daily-digest-empty">
        <p style="margin:0 0 6px;font-weight:600">Today's digest hasn't been generated yet.</p>
        <p style="margin:0 0 18px;font-size:13px;color:var(--text-secondary)">Digests are generated at 8am CET for: ${escapeHtml(topicList)}</p>
        ${manageBtn}
      </div>`;
    return;
  }

  const d = _dailyDigests[_dailyDigestIdx];
  const total = _dailyDigests.length;

  const tabs = _dailyDigests.map((dig, i) =>
    `<button class="daily-tab ${i === _dailyDigestIdx ? 'active' : ''}" onclick="_switchDailyTab(${i})">${escapeHtml(dig.topic)}</button>`
  ).join('');

  const wordsBadge = d.words?.length
    ? `<span class="daily-topic-badge">${escapeHtml(d.words.slice(0, 4).join(' · '))}${d.words.length > 4 ? ` +${d.words.length - 4}` : ''}</span>`
    : '';

  const refsHtml = d.papers?.length
    ? d.papers.map((p, i) =>
        `<li id="ref-${i + 1}"><a href="${escapeHtml(p.url || '#')}" target="_blank" rel="noopener">${escapeHtml(p.title || `Paper ${i + 1}`)}</a>` +
        (p.authors ? `<br><span class="digest-ref-meta">${escapeHtml(formatAuthorsShort(p.authors))}</span>` : '') +
        `</li>`
      ).join('')
    : '';

  content.innerHTML = `
    <div class="daily-digest-header">
      <div class="daily-digest-title-area">
        <div class="daily-digest-label">Daily Digest · ${formattedDate}${wordsBadge ? ' ' + wordsBadge : ''}</div>
        <div class="daily-digest-tabs">${tabs}</div>
      </div>
      ${closeBtn}
    </div>
    <div class="daily-digest-body">
      ${digestMarkdownToHtml(d.markdown || '')}
      ${refsHtml ? `<div class="digest-references daily-digest-refs"><h3>References</h3><ol>${refsHtml}</ol></div>` : ''}
    </div>
    <div class="daily-digest-footer">
      ${manageBtn}
      <div style="display:flex;align-items:center;gap:8px;margin-left:auto;">
        <button class="button daily-save-btn" onclick="_saveDailyDigest()">Save</button>
        <button class="digest-view-nav-btn button" onclick="_switchDailyTab(${_dailyDigestIdx - 1})" ${_dailyDigestIdx === 0 ? 'disabled' : ''}>← Prev</button>
        <span class="daily-digest-count">${_dailyDigestIdx + 1} / ${total}</span>
        <button class="digest-view-nav-btn button" onclick="_switchDailyTab(${_dailyDigestIdx + 1})" ${_dailyDigestIdx === total - 1 ? 'disabled' : ''}>Next →</button>
      </div>
    </div>`;

  document.onkeydown = (e) => {
    if (document.getElementById('dailyDigestModal')?.style.display !== 'flex') return;
    if (document.getElementById('manageSubModal')?.style.display === 'flex') return;
    if (e.key === 'ArrowLeft') _switchDailyTab(_dailyDigestIdx - 1);
    if (e.key === 'ArrowRight') _switchDailyTab(_dailyDigestIdx + 1);
    if (e.key === 'Escape') closeDailyDigestModal();
  };
}

function _switchDailyTab(idx) {
  if (idx < 0 || idx >= (_dailyDigests?.length || 0)) return;
  _dailyDigestIdx = idx;
  _renderDailyDigestModal();
}

function _saveDailyDigest() {
  const d = _dailyDigests?.[_dailyDigestIdx];
  if (!d) return;
  saveDigest(d.markdown, d.papers || [], d.topic);
  const btn = document.querySelector('.daily-save-btn');
  if (btn) { btn.textContent = 'Saved!'; setTimeout(() => { if (btn) btn.textContent = 'Save'; }, 2000); }
}

// ── Auto-show on first load ───────────────────────────────────────────────────

async function checkAndShowDailyDigest() {
  const subs = JSON.parse(localStorage.getItem('topicSubscriptions') || '[]');
  if (!subs.length) return;
  const now = new Date();
  const today = now.toLocaleDateString('en-CA');
  if (localStorage.getItem('dailyDigestShownDate') === today) return;
  if (now.getHours() < 8) return;
  await _fetchDailyDigests();
  if (!_dailyDigests?.length) return;
  localStorage.setItem('dailyDigestShownDate', today);
  const modal = document.getElementById('dailyDigestModal');
  if (modal) { modal.style.display = 'flex'; document.body.style.overflow = 'hidden'; }
  _renderDailyDigestModal();
}

// ── Manage Subscriptions modal ────────────────────────────────────────────────

function openManageSubModal() {
  const modal = document.getElementById('manageSubModal');
  if (!modal) return;
  _manageSubs = JSON.parse(JSON.stringify(JSON.parse(localStorage.getItem('topicSubscriptions') || '[]')));
  _managePendingTopics = [];
  _manageWordData = new Map();
  _manageActiveTopicForWords = null;
  _manageNewTopicData = null;
  _manageNewTopicWords = new Set();
  _manageTopicInputValue = '';
  const allPapers = [...new Map(Object.values(paperData).flat().map(p => [p.id, p])).values()];
  _manageSubs.forEach(s => {
    _manageWordData.set(s.topic, _buildSubTopicData(s.topic, allPapers, s.words || null));
  });
  _renderManageSubModal();
  modal.style.display = 'flex';
}

function closeManageSubModal() {
  const modal = document.getElementById('manageSubModal');
  if (modal) modal.style.display = 'none';
}

function _renderManageSubModal() {
  const content = document.getElementById('manageSubContent');
  if (!content) return;

  // Add topic section (always at top)
  const newWordBtns = _manageNewTopicData?.words?.slice(0, 24).map(({ word }) => {
    const sel = _manageNewTopicWords.has(word);
    return `<button class="topic-word-btn ${sel ? 'active' : ''}" onclick="_toggleNewTopicWord('${word.replace(/'/g, "\\'")}')">${escapeHtml(word)}</button>`;
  }).join('') || '';

  const addSection = `
    <div class="manage-sub-section">
      <label class="subscribe-label">Add topic</label>
      <div class="manage-add-row">
        <input id="manageTopicInput" type="text" class="manage-topic-input" placeholder="e.g. diffusion model"
          oninput="_onManageTopicInput(this.value)"
          onkeydown="if(event.key==='Enter')_addManageTopic()">
        <button class="button primary" onclick="_addManageTopic()">Add</button>
      </div>
      ${newWordBtns ? `<div class="manage-new-words"><span class="topic-words-sub-label">Select filter words:</span><div class="topic-words-sub-tags">${newWordBtns}</div></div>` : ''}
    </div>`;

  // Subscribed topics section
  const subsCards = _manageSubs.map((s, i) => _renderTopicCard(s, i, false)).join('');
  const subsSection = `
    <div class="manage-sub-section">
      <label class="subscribe-label">Subscribed</label>
      ${_manageSubs.length ? `<div class="manage-topic-cards">${subsCards}</div>` : '<p class="sub-no-topics">No subscribed topics yet.</p>'}
    </div>`;

  // Pending topics section
  let pendingSection = '';
  if (_managePendingTopics.length) {
    const pendingCards = _managePendingTopics.map((s, i) => _renderTopicCard(s, i, true)).join('');
    pendingSection = `
      <div class="manage-sub-section">
        <label class="subscribe-label">Pending <span class="manage-pending-badge">unsaved</span></label>
        <div class="manage-topic-cards">${pendingCards}</div>
      </div>`;
  }

  // Capture input state before re-render (innerHTML destroys the old element)
  const prevInput = document.getElementById('manageTopicInput');
  const cursorPos = prevInput ? prevInput.selectionStart : null;
  const inputHadFocus = prevInput !== null && prevInput === document.activeElement;

  content.innerHTML = addSection + subsSection + pendingSection +
    `<p class="sub-schedule-note">Digests generated server-side at 8am CET · Requires GitHub token in Settings</p>`;

  // Restore input value, cursor position, and focus
  const input = document.getElementById('manageTopicInput');
  if (input) {
    if (_manageTopicInputValue) input.value = _manageTopicInputValue;
    if (inputHadFocus) {
      input.focus();
      if (cursorPos !== null) {
        try { input.setSelectionRange(cursorPos, cursorPos); } catch (_) {}
      }
    }
  }
}

function _renderTopicCard(s, idx, isPending) {
  const isActive = _manageActiveTopicForWords === s.topic;
  const data = _manageWordData.get(s.topic);
  const selectedWords = data ? [...data.selectedWords] : (s.words || []);
  const wordBadges = selectedWords.slice(0, 5).map(w =>
    `<span class="topic-card-word">${escapeHtml(w)}</span>`).join('') +
    (selectedWords.length > 5 ? `<span class="topic-card-word-more">+${selectedWords.length - 5}</span>` : '');

  let wordPickerHtml = '';
  if (isActive && data && data.words.length > 0) {
    const wordBtns = data.words.slice(0, 30).map(({ word }) => {
      const isSel = data.selectedWords.has(word);
      return `<button class="topic-word-btn ${isSel ? 'active' : ''}" onclick="_toggleManageWord('${s.topic.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${word}')">${escapeHtml(word)}</button>`;
    }).join('');
    wordPickerHtml = `<div class="manage-word-picker"><div class="topic-words-sub-tags">${wordBtns}</div></div>`;
  }

  const topicEsc = s.topic.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `
    <div class="manage-topic-card ${isActive ? 'active' : ''}">
      <div class="manage-topic-card-header">
        <button class="manage-topic-card-name" onclick="_selectManageTopicForWords('${topicEsc}')">${escapeHtml(s.topic)}</button>
        <div class="manage-topic-card-words">${wordBadges || '<span class="manage-no-words">no filter words</span>'}</div>
        <button class="manage-chip-remove" onclick="${isPending ? `_removePendingTopic(${idx})` : `_removeManageSub(${idx})`}" title="Remove">×</button>
      </div>
      ${wordPickerHtml}
    </div>`;
}

function _selectManageTopicForWords(topic) {
  _manageActiveTopicForWords = (_manageActiveTopicForWords === topic) ? null : topic;
  _renderManageSubModal();
}

function _onManageTopicInput(value) {
  _manageTopicInputValue = value;
  if (_manageInputTimer) clearTimeout(_manageInputTimer);
  if (!value.trim()) {
    _manageNewTopicData = null;
    _manageNewTopicWords = new Set();
    _renderManageSubModal();
    return;
  }
  _manageInputTimer = setTimeout(() => {
    const allPapers = [...new Map(Object.values(paperData).flat().map(p => [p.id, p])).values()];
    _manageNewTopicData = _buildSubTopicData(value.trim(), allPapers, null);
    _manageNewTopicWords = new Set();
    _renderManageSubModal();
  }, 400);
}

function _toggleNewTopicWord(word) {
  if (_manageNewTopicWords.has(word)) _manageNewTopicWords.delete(word);
  else _manageNewTopicWords.add(word);
  _renderManageSubModal();
}

function _addManageTopic() {
  const topic = _manageTopicInputValue.trim();
  if (!topic) return;
  const allTopics = [..._manageSubs, ..._managePendingTopics].map(s => s.topic);
  if (allTopics.includes(topic)) {
    _manageTopicInputValue = '';
    _manageNewTopicData = null;
    _manageNewTopicWords = new Set();
    _renderManageSubModal();
    return;
  }
  const words = [..._manageNewTopicWords];
  const allPapers = [...new Map(Object.values(paperData).flat().map(p => [p.id, p])).values()];
  const topicData = _manageNewTopicData || _buildSubTopicData(topic, allPapers, null);
  _manageWordData.set(topic, { words: topicData.words, selectedWords: new Set(words) });
  _managePendingTopics.push({ topic, words });
  _manageTopicInputValue = '';
  _manageNewTopicData = null;
  _manageNewTopicWords = new Set();
  _renderManageSubModal();
}

function _removeManageSub(idx) {
  const removed = _manageSubs[idx]?.topic;
  _manageSubs.splice(idx, 1);
  if (_manageActiveTopicForWords === removed) _manageActiveTopicForWords = null;
  _renderManageSubModal();
}

function _removePendingTopic(idx) {
  const removed = _managePendingTopics[idx]?.topic;
  _managePendingTopics.splice(idx, 1);
  if (_manageActiveTopicForWords === removed) _manageActiveTopicForWords = null;
  _renderManageSubModal();
}

function _toggleManageWord(topic, word) {
  const data = _manageWordData.get(topic);
  if (!data) return;
  if (data.selectedWords.has(word)) data.selectedWords.delete(word);
  else data.selectedWords.add(word);
  _renderManageSubModal();
}

async function saveSubscription() {
  // Merge pending into subscribed
  _managePendingTopics.forEach(p => {
    if (!_manageSubs.find(s => s.topic === p.topic)) _manageSubs.push(p);
  });
  _managePendingTopics = [];

  _manageSubs.forEach(s => {
    const data = _manageWordData.get(s.topic);
    s.words = data ? [...data.selectedWords] : [];
  });
  localStorage.setItem('topicSubscriptions', JSON.stringify(_manageSubs));
  _dailyDigests = null; // reset so next open refetches with updated topics

  const saveBtn = document.getElementById('manageSaveBtn');
  if (saveBtn) { saveBtn.textContent = 'Saving…'; saveBtn.disabled = true; }

  const token = localStorage.getItem('githubToken');
  if (token) {
    try {
      await _writeSubscriptionTopics(_manageSubs.map(s => s.topic));
    } catch (e) {
      console.warn('Could not sync to data branch:', e.message);
    }
  } else {
    showConfigRequiredModal('save');
  }

  if (saveBtn) saveBtn.textContent = 'Saved!';
  setTimeout(() => {
    closeManageSubModal();
    if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
    if (document.getElementById('dailyDigestModal')?.style.display === 'flex') {
      _renderDailyDigestModal();
    }
  }, 700);
}

async function _writeSubscriptionTopics(topics) {
  const { repoOwner, repoName, dataBranch } = DATA_CONFIG;
  const token = localStorage.getItem('githubToken');
  const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/subscription-topics.json`;
  const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };

  let sha = null;
  let existing = [];
  const getRes = await fetch(`${apiUrl}?ref=${dataBranch}`, { headers, cache: 'no-store' });
  if (getRes.ok) {
    const f = await getRes.json();
    sha = f.sha;
    try { existing = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(f.content.replace(/\n/g, '')), c => c.charCodeAt(0)))); } catch (_) {}
  }

  const merged = [...new Set([...existing, ...topics])];
  const newJson = JSON.stringify(merged, null, 2);
  const encoded = new TextEncoder().encode(newJson);
  let binary = '';
  for (let i = 0; i < encoded.length; i++) binary += String.fromCharCode(encoded[i]);
  const body = { message: 'subscription: update topics', content: btoa(binary), branch: dataBranch };
  if (sha) body.sha = sha;

  const putRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!putRes.ok) throw new Error(`GitHub API ${putRes.status}`);}
