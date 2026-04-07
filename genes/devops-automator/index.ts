export function express(input: { prompt: string }): {
  result: string;
} {
  const text = (input && input.prompt) || "";
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  const stages: string[] = [];
  const jobs: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  const stagePattern = /^(stage|stages)\s*[:=>\-]\s*(.+)/i;
  const jobPattern = /^(job|step|task|run)\s*[:=>\-]\s*(.+)/i;
  const namedBlockPattern = /^-?\s*(build|test|lint|deploy|release|publish|install|cache|checkout|setup|notify|scan|audit)\b/i;

  let hasBuild = false;
  let hasTest = false;
  let hasDeploy = false;
  let hasCache = false;
  let hasLint = false;
  let hasNotify = false;

  for (const line of lines) {
    const stageMatch = line.match(stagePattern);
    if (stageMatch) {
      const stageNames = stageMatch[2].split(/[,|;]/).map((s) => s.trim()).filter(Boolean);
      for (const s of stageNames) {
        stages.push(s.toLowerCase());
      }
      continue;
    }

    const jobMatch = line.match(jobPattern);
    if (jobMatch) {
      jobs.push(jobMatch[2].trim());
      continue;
    }

    const blockMatch = line.match(namedBlockPattern);
    if (blockMatch) {
      const name = blockMatch[1].toLowerCase();
      if (!stages.includes(name)) stages.push(name);
    }
  }

  const allTokens = text.toLowerCase();

  hasBuild = stages.includes("build") || allTokens.includes("build");
  hasTest = stages.includes("test") || allTokens.includes("test") || allTokens.includes("jest") || allTokens.includes("vitest");
  hasDeploy = stages.includes("deploy") || allTokens.includes("deploy") || allTokens.includes("publish");
  hasCache = allTokens.includes("cache") || allTokens.includes("caching");
  hasLint = allTokens.includes("lint") || allTokens.includes("eslint") || allTokens.includes("prettier");
  hasNotify = allTokens.includes("notify") || allTokens.includes("notification") || allTokens.includes("slack");

  if (!hasTest) {
    warnings.push("MISSING_TEST_STAGE: No test stage detected. Pipelines should include automated tests.");
    suggestions.push("Add a test stage with unit and integration tests before deploy.");
  }

  if (hasDeploy && !hasBuild) {
    warnings.push("DEPLOY_WITHOUT_BUILD: Deploy stage found without a preceding build stage.");
    suggestions.push("Add a build stage before deploy to ensure artifacts are compiled.");
  }

  if (!hasCache) {
    warnings.push("NO_CACHING: No caching configuration detected.");
    suggestions.push("Enable dependency caching (node_modules, pip cache) to speed up pipelines.");
  }

  if (hasDeploy && !hasTest) {
    warnings.push("DEPLOY_WITHOUT_TEST: Deploying without running tests is risky.");
    suggestions.push("Gate deployments behind passing test suites.");
  }

  if (!hasLint) {
    suggestions.push("Consider adding a lint stage for code quality checks.");
  }

  if (!hasNotify) {
    suggestions.push("Consider adding notifications (Slack, email) for pipeline failures.");
  }

  const isValid = warnings.length === 0;

  const output = {
    stagesFound: stages.length > 0 ? stages : ["(none detected)"],
    jobsFound: jobs.length > 0 ? jobs : ["(none detected)"],
    flags: { hasBuild, hasTest, hasDeploy, hasCache, hasLint },
    warnings,
    suggestions,
    isValid,
    summary: isValid
      ? `Pipeline looks healthy with ${stages.length} stages detected.`
      : `Found ${warnings.length} issue(s) in pipeline configuration.`,
  };

  return { result: JSON.stringify(output, null, 2) };
}
