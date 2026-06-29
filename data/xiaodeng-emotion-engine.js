(function () {
  const data = window.XIAODENG_EMOTION_DATA;
  if (!data) throw new Error("XIAODENG_EMOTION_DATA is required before the emotion engine");

  function normalize(text) {
    return String(text || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\t\r]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function bigrams(value) {
    const chars = Array.from(value.replace(/[\s，。！？!?；;、]/g, ""));
    if (chars.length < 2) return new Set(chars);
    const result = new Set();
    for (let index = 0; index < chars.length - 1; index++) result.add(chars[index] + chars[index + 1]);
    return result;
  }

  function diceSimilarity(left, right) {
    const leftSet = bigrams(left);
    const rightSet = bigrams(right);
    if (!leftSet.size || !rightSet.size) return 0;
    let overlap = 0;
    leftSet.forEach(item => {
      if (rightSet.has(item)) overlap++;
    });
    return (2 * overlap) / (leftSet.size + rightSet.size);
  }

  function splitChunks(text) {
    const turnPattern = new RegExp(`(${data.modifiers.turns.join("|")})`, "g");
    const marked = text.replace(turnPattern, "。$1");
    return marked
      .split(/[。！？!?；;\n]+/)
      .map(chunk => chunk.trim())
      .filter(Boolean)
      .map((chunk, index, chunks) => ({
        text: chunk,
        weight: index === chunks.length - 1 ? 1.12 : data.modifiers.turns.some(turn => chunk.startsWith(turn)) ? 1.16 : 1
      }));
  }

  function precedingWindow(text, index, size = 6) {
    return text.slice(Math.max(0, index - size), index);
  }

  function modifierMultiplier(text, index) {
    const windowText = precedingWindow(text, index, 7);
    if (data.modifiers.negators.some(word => windowText.endsWith(word) || windowText.includes(word))) return 0.12;
    let multiplier = 1;
    if (data.modifiers.intensifiers.some(word => windowText.includes(word))) multiplier *= 1.34;
    if (data.modifiers.diminishers.some(word => windowText.includes(word))) multiplier *= 0.74;
    return multiplier;
  }

  function findExactMatches(chunk, terms) {
    const occupied = new Uint8Array(chunk.length);
    const matches = [];
    const sorted = [...terms].sort((left, right) => right[0].length - left[0].length);

    sorted.forEach(([term, weight]) => {
      let start = 0;
      while (start < chunk.length) {
        const index = chunk.indexOf(term, start);
        if (index === -1) break;
        const end = index + term.length;
        let overlaps = false;
        for (let position = index; position < end; position++) {
          if (occupied[position]) {
            overlaps = true;
            break;
          }
        }
        if (!overlaps) {
          for (let position = index; position < end; position++) occupied[position] = 1;
          matches.push({ term, index, weight, type: "exact", similarity: 1 });
        }
        start = index + Math.max(1, term.length);
      }
    });

    return matches;
  }

  function bestFuzzyMatch(chunk, term) {
    if (term.length < 3 || chunk.length < 2) return null;
    let best = null;
    const minLength = Math.max(2, term.length - 1);
    const maxLength = Math.min(chunk.length, term.length + 2);
    for (let size = minLength; size <= maxLength; size++) {
      for (let index = 0; index <= chunk.length - size; index++) {
        const candidate = chunk.slice(index, index + size);
        const similarity = diceSimilarity(candidate, term);
        if (!best || similarity > best.similarity) best = { candidate, index, similarity };
      }
    }
    return best && best.similarity >= 0.76 ? best : null;
  }

  function checkSafety(text) {
    for (const [category, phrases] of Object.entries(data.safety)) {
      if (!Array.isArray(phrases)) continue;
      const phrase = phrases.find(item => text.includes(item));
      if (phrase) return { level: "urgent", category, evidence: phrase, message: data.safety.message };
    }
    return { level: "normal" };
  }

  function analyze(rawText, options = {}) {
    const text = normalize(rawText);
    const safety = checkSafety(text);
    if (!text) return { text, safety, candidates: [], confidence: 0, contexts: [], evidence: [], masks: [] };
    if (safety.level !== "normal") return { text, safety, candidates: [], confidence: 1, contexts: [], evidence: [safety.evidence], masks: [] };

    const chunks = splitChunks(text);
    const scores = {};
    const evidence = {};
    let fuzzyEvidenceCount = 0;

    Object.entries(data.emotions).forEach(([emotionKey, emotion]) => {
      scores[emotionKey] = 0;
      evidence[emotionKey] = [];
      chunks.forEach(chunk => {
        const exactMatches = findExactMatches(chunk.text, emotion.terms);
        const exactTerms = new Set(exactMatches.map(match => match.term));
        exactMatches.forEach(match => {
          const multiplier = modifierMultiplier(chunk.text, match.index);
          scores[emotionKey] += match.weight * chunk.weight * multiplier;
          evidence[emotionKey].push({ text: match.term, type: match.type, weight: match.weight * multiplier });
        });

        emotion.terms.forEach(([term, weight]) => {
          if (exactTerms.has(term) || chunk.text.includes(term) || term.length < 3) return;
          const fuzzy = bestFuzzyMatch(chunk.text, term);
          if (!fuzzy) return;
          const multiplier = modifierMultiplier(chunk.text, fuzzy.index);
          const fuzzyWeight = weight * fuzzy.similarity * 0.42 * chunk.weight * multiplier;
          if (fuzzyWeight < 0.65) return;
          scores[emotionKey] += fuzzyWeight;
          fuzzyEvidenceCount++;
          evidence[emotionKey].push({ text: fuzzy.candidate, matched: term, type: "fuzzy", similarity: fuzzy.similarity, weight: fuzzyWeight });
        });
      });
    });

    const matchedContexts = [];
    Object.entries(data.contexts).forEach(([contextKey, context]) => {
      const matchedTerms = context.terms.filter(term => text.includes(term));
      if (!matchedTerms.length) return;
      matchedContexts.push({ key: contextKey, label: context.label, evidence: matchedTerms });
      Object.entries(context.boosts).forEach(([emotionKey, multiplier]) => {
        if (scores[emotionKey] > 0) scores[emotionKey] *= multiplier;
      });
    });

    const weatherKey = options.weather;
    if (weatherKey && data.weatherBoosts[weatherKey]) {
      Object.entries(data.weatherBoosts[weatherKey]).forEach(([emotionKey, multiplier]) => {
        if (scores[emotionKey] > 0) scores[emotionKey] *= multiplier;
      });
    }

    const masks = data.masks.filter(item => text.includes(item));
    const candidates = Object.entries(scores)
      .filter(([, score]) => score > 0.45)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([key, score]) => ({
        key,
        label: data.emotions[key].label,
        score: Number(score.toFixed(2)),
        petState: data.emotions[key].petState,
        weather: data.emotions[key].weather,
        dungeon: data.emotions[key].dungeon,
        evidence: evidence[key].slice(0, 5)
      }));

    const top = candidates[0]?.score || 0;
    const second = candidates[1]?.score || 0;
    const evidenceCount = candidates[0]?.evidence.length || 0;
    let confidence = top ? Math.min(0.95, (top / (top + 4)) * 0.62 + ((top - second) / (top + 1)) * 0.24 + Math.min(0.14, evidenceCount * 0.035)) : 0;
    if (fuzzyEvidenceCount && evidenceCount <= 1) confidence *= 0.72;
    if (masks.length && top < 3) confidence *= 0.78;

    return {
      text,
      safety,
      candidates,
      confidence: Number(Math.max(0, confidence).toFixed(2)),
      contexts: matchedContexts,
      evidence,
      masks,
      needsConfirmation: true
    };
  }

  function getEmotion(key) {
    return data.emotions[key] || null;
  }

  window.XiaodengEmotionEngine = { analyze, getEmotion, normalize, diceSimilarity };
})();
