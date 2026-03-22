/**
 * Content Pipeline Demo
 *
 * Demonstrates composing 3 Native Genes (grammar-checker, readability-analyzer,
 * seo-optimizer) into a unified content quality pipeline.
 *
 * Run: npx tsx tests/demo/content-pipeline-demo.ts
 */

import { express as grammarCheck } from "../../genes/grammar-checker/index.js";
import { express as readabilityAnalyze } from "../../genes/readability-analyzer/index.js";
import { express as seoOptimize } from "../../genes/seo-optimizer/index.js";

const SAMPLE_CONTENT = `
<title>How AI is Transforming Education in 2025</title>
<meta name="description" content="Discover how artificial intelligence is revolutionizing education with personalized learning and automated grading systems.">

<h1>How AI is Transforming Education in 2025</h1>

Artificial intelligence is reshaping how we learn and teach.  From personalized
learning paths to automated grading, the impact of AI on education is is profound
and far-reaching.

<h2>Personalized Learning</h2>

AI-powered platforms can analyze a student's performance and adapt content to their
individual needs. This means every student gets a tailored learning experience.
Machine learning algorithms track progress and identify knowledge gaps in real time.

<h2>Automated Grading and Feedback</h2>

Teachers spend countless hours grading assignments. AI can automate much of this
process, providing instant feedback to students. This frees up teachers to focus
on mentoring and creative instruction.

<h2>Challenges and Considerations</h2>

However there are challenges to consider. Privacy concerns around student data
collection remain significant. The cost of implementing AI systems can be
prohibitive for underfunded schools. Teacher training is essential but often
overlooked.

Despite these challenges, the potential of AI in education is immense. As
technology continues to evolve, we can expect even more innovative applications
in the years to come.
`;

async function runPipeline() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Rotifer Content Pipeline Demo");
  console.log("  Genes: grammar-checker → readability-analyzer → seo-optimizer");
  console.log("═══════════════════════════════════════════════════════════\n");

  const plainText = SAMPLE_CONTENT.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const start = performance.now();

  // Step 1: Grammar Check
  console.log("──── Step 1: Grammar Checker ────");
  const t1 = performance.now();
  const grammarResult = await grammarCheck({ text: plainText });
  const d1 = performance.now() - t1;
  console.log(`  Score: ${grammarResult.score}/100`);
  console.log(`  Issues found: ${grammarResult.issues.length}`);
  for (const issue of grammarResult.issues.slice(0, 5)) {
    console.log(`    • [${issue.rule}] ${issue.message} (pos ${issue.position})`);
    console.log(`      → ${issue.suggestion}`);
  }
  if (grammarResult.issues.length > 5)
    console.log(`    ... and ${grammarResult.issues.length - 5} more`);
  console.log(`  Duration: ${d1.toFixed(1)}ms\n`);

  // Step 2: Readability Analysis
  console.log("──── Step 2: Readability Analyzer ────");
  const t2 = performance.now();
  const readabilityResult = await readabilityAnalyze({ text: plainText });
  const d2 = performance.now() - t2;
  console.log(`  Flesch-Kincaid Reading Ease: ${readabilityResult.fleschKincaid}`);
  console.log(`  Grade Level: ${readabilityResult.gradeLevel}`);
  console.log(`  Words: ${readabilityResult.wordCount}, Sentences: ${readabilityResult.sentenceCount}`);
  console.log(`  Avg Sentence Length: ${readabilityResult.avgSentenceLength} words`);
  console.log(`  Avg Syllables/Word: ${readabilityResult.avgSyllablesPerWord}`);
  console.log(`  Complex Word Ratio: ${(readabilityResult.complexWordRatio * 100).toFixed(1)}%`);
  console.log(`  Verdict: ${readabilityResult.verdict}`);
  console.log(`  Duration: ${d2.toFixed(1)}ms\n`);

  // Step 3: SEO Analysis
  console.log("──── Step 3: SEO Optimizer ────");
  const t3 = performance.now();
  const seoResult = await seoOptimize({
    content: SAMPLE_CONTENT,
    targetKeyword: "AI education",
  });
  const d3 = performance.now() - t3;
  console.log(`  SEO Score: ${seoResult.score}/100`);
  console.log(`  Word Count: ${seoResult.wordCount}`);
  console.log(`  Keyword Density: ${seoResult.keywordDensity}%`);
  console.log(`  Headings: H1=${seoResult.headingStructure.h1Count} H2=${seoResult.headingStructure.h2Count} H3=${seoResult.headingStructure.h3Count}`);
  console.log(`  Proper Hierarchy: ${seoResult.headingStructure.hasProperHierarchy}`);
  console.log(`  Title Length: ${seoResult.metaAnalysis.titleLength} chars`);
  console.log(`  Has Meta Description: ${seoResult.metaAnalysis.hasMetaDescription}`);
  console.log(`  Readability Score: ${seoResult.readabilityScore}`);
  console.log(`  Issues:`);
  for (const issue of seoResult.issues) {
    console.log(`    • [${issue.severity}] ${issue.rule}: ${issue.message}`);
  }
  console.log(`  Duration: ${d3.toFixed(1)}ms\n`);

  // Combined Report
  const totalTime = performance.now() - start;
  const overallScore = Math.round(
    (grammarResult.score * 0.3 + (readabilityResult.fleschKincaid) * 0.3 + seoResult.score * 0.4)
  );

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Combined Content Quality Report");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Overall Score: ${overallScore}/100`);
  console.log(`  Grammar:     ${grammarResult.score}/100 (${grammarResult.issues.length} issues)`);
  console.log(`  Readability: ${readabilityResult.fleschKincaid}/100 (${readabilityResult.verdict})`);
  console.log(`  SEO:         ${seoResult.score}/100 (${seoResult.issues.length} issues)`);
  console.log(`  Total Time:  ${totalTime.toFixed(1)}ms`);
  console.log("═══════════════════════════════════════════════════════════");
}

runPipeline().catch(console.error);
