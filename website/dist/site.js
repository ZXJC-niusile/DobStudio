const demo = document.querySelector(".demo");
const modes = {
  subtitle: [
    "识别字幕",
    "本地识别",
    "识别原声，检查每句文字与时间。",
    "本地识别语音，生成可编辑的字幕。",
  ],
  translate: [
    "对照翻译",
    "EN / 中文",
    "原文与译文，逐句校对。",
    "接入自己的翻译 API，逐句校对双语字幕。",
  ],
  voice: [
    "声音与配音",
    "参考人声",
    "生成配音，再与背景伴奏混音。",
    "配置配音模型与参考人声，为译文生成配音。",
  ],
};
function bindTabs(selector, onSelect) {
  const tabs = [...document.querySelectorAll(selector)];
  function select(tab) {
    tabs.forEach((t) => {
      t.setAttribute("aria-selected", String(t === tab));
      t.tabIndex = t === tab ? 0 : -1;
    });
    onSelect(tab);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft")
        next = (index + tabs.length - 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        select(tabs[next]);
        tabs[next].focus();
      }
    });
  });
}
bindTabs("button[data-mode]", (tab) => {
  const mode = modes[tab.dataset.mode];
  demo.dataset.mode = tab.dataset.mode;
  const originals = [
    "Some places ask you to stay.",
    "Slow down. Listen to the mountains.",
    "There is a world beyond the noise.",
  ];
  const translations = [
    "有些地方，让人想多留一会儿。",
    "走得慢一点，才能听见山的声音。",
    "喧嚣之外，另有天地。",
  ];
  document.querySelectorAll(".clips i").forEach((clip, i) => {
    clip.textContent = (
      tab.dataset.mode === "subtitle" ? originals : translations
    )[i];
  });
  document.querySelector("#demo-heading").textContent = mode[0];
  document.querySelector("#demo-tag").textContent = mode[1];
  document.querySelector("#demo-foot").textContent = mode[2];
  const panel = document.querySelector("#mode-description");
  panel.textContent = mode[3];
  panel.setAttribute("aria-labelledby", tab.id);
});
const exampleCues = [
  {
    start: 8,
    end: 12,
    original: "Some places ask you to stay.",
    translation: "有些地方，让人想多留一会儿。",
  },
  {
    start: 12,
    end: 16,
    original: "Slow down. Listen to the mountains.",
    translation: "走得慢一点，才能听见山的声音。",
  },
  {
    start: 16,
    end: 20,
    original: "There is a world beyond the noise.",
    translation: "喧嚣之外，另有天地。",
  },
];
const initialTranslations = exampleCues.map((cue) => cue.translation);
let selectedCue = 1,
  captionMode = "bilingual";
const translationInput = document.querySelector("#translation-input");
const cueButtons = [...document.querySelectorAll("[data-cue]")];
const previewZh = document.querySelector("#edit-preview-zh");
const previewEn = document.querySelector("#edit-preview-en");
function cueTime(seconds) {
  return "00:" + String(seconds).padStart(2, "0");
}
function renderPreview() {
  const cue = exampleCues[selectedCue];
  previewZh.textContent = cue.translation;
  previewEn.textContent = cue.original;
  previewZh.hidden = captionMode === "original";
  previewEn.hidden = captionMode === "translated";
}
function selectCue(index) {
  selectedCue = index;
  const cue = exampleCues[index];
  cueButtons.forEach((button, i) =>
    button.setAttribute("aria-pressed", String(i === index)),
  );
  document.querySelector("#source-text").textContent = cue.original;
  translationInput.value = cue.translation;
  document.querySelector("#edit-time").textContent =
    cueTime(cue.start) + " — " + cueTime(cue.end);
  document.querySelector("#cue-counter").textContent =
    "0" + (index + 1) + " / 03";
  document.querySelector("#edit-status").textContent = "点击译文即可编辑";
  renderPreview();
}
cueButtons.forEach((button, i) =>
  button.addEventListener("click", () => selectCue(i)),
);
translationInput.addEventListener("input", () => {
  exampleCues[selectedCue].translation = translationInput.value;
  cueButtons[selectedCue].lastElementChild.textContent =
    translationInput.value || "空字幕";
  document.querySelector("#edit-status").textContent = "预览已更新";
  renderPreview();
});
document.querySelectorAll("[data-caption]").forEach((button) => {
  button.addEventListener("click", () => {
    captionMode = button.dataset.caption;
    document
      .querySelectorAll("[data-caption]")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    renderPreview();
  });
});
document.querySelector("#reset-example").addEventListener("click", () => {
  exampleCues.forEach((cue, i) => {
    cue.translation = initialTranslations[i];
    cueButtons[i].lastElementChild.textContent = cue.translation;
  });
  selectCue(selectedCue);
  document.querySelector("#edit-status").textContent = "示例已还原";
});
document.querySelector("#export-example").addEventListener("click", () => {
  const timestamp = (seconds) =>
    "00:00:" + String(seconds).padStart(2, "0") + ",000";
  const srt =
    exampleCues
      .map(
        (cue, i) =>
          i +
          1 +
          "\n" +
          timestamp(cue.start) +
          " --> " +
          timestamp(cue.end) +
          "\n" +
          cue.translation +
          "\n" +
          cue.original,
      )
      .join("\n\n") + "\n";
  const url = URL.createObjectURL(
    new Blob(["\uFEFF" + srt], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "DobStudio-example.srt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
selectCue(selectedCue);

const wave = document.querySelector(".voice-wave");
[
  14, 22, 35, 18, 28, 40, 26, 17, 32, 20, 13, 27, 37, 21, 30, 16, 24, 34, 18,
  12, 28, 38, 20, 15,
].forEach((height, i) => {
  const bar = document.createElement("i");
  bar.style.setProperty("--h", height + "px");
  bar.style.setProperty("--delay", (i % 7) * -0.12 + "s");
  wave.append(bar);
});
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.documentElement.classList.add("js-motion");
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1 },
  );
  document
    .querySelectorAll(".reveal")
    .forEach((element) => observer.observe(element));
}
