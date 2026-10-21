import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TestSandbox } from "./test-sandbox";
import {
  buildGitHubTools,
  parseGitHubRemote,
  parseRepositoryInput,
} from "./github";

test("parses GitHub HTTPS and SSH remotes", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/acme/widgets.git"), {
    owner: "acme",
    repo: "widgets",
  });
  assert.deepEqual(parseGitHubRemote("https://github.com/acme/widgets"), {
    owner: "acme",
    repo: "widgets",
  });
  assert.deepEqual(parseGitHubRemote("git@github.com:acme/widgets.git"), {
    owner: "acme",
    repo: "widgets",
  });
  assert.deepEqual(
    parseGitHubRemote("ssh://git@github.com/acme/widgets.git"),
    { owner: "acme", repo: "widgets" },
  );
  assert.equal(parseGitHubRemote("https://gitlab.com/acme/widgets.git"), null);
  assert.equal(parseGitHubRemote("https://github.com/acme"), null);
  assert.equal(parseGitHubRemote("not a url"), null);
});

test("parses repository input with a fallback owner", () => {
  assert.deepEqual(parseRepositoryInput("acme/widgets", "me"), {
    owner: "acme",
    repo: "widgets",
  });
  assert.deepEqual(parseRepositoryInput("widgets", "me"), {
    owner: "me",
    repo: "widgets",
  });
  assert.equal(parseRepositoryInput("acme/widgets/extra", "me"), null);
  assert.equal(parseRepositoryInput("acme/widgets;rm", "me"), null);
  assert.equal(parseRepositoryInput(undefined, "me"), null);
});

test("the GitHub tool refuses to publish without a remote or create flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buildx-github-"));
  const sandbox = new TestSandbox({ rootDir: dir });
  try {
    const tools = buildGitHubTools(sandbox, {
      getAuth: async () => ({
        token: "secret-token",
        username: "octocat",
        login: "octocat",
      }),
    });
    await assert.rejects(
      async () => {
        await tools.github_create_pull_request.execute(
          { title: "Publish the app" },
          { messages: [], toolCallId: "call_1" } as never,
        );
      },
      /no GitHub remote/i,
    );
    await assert.rejects(
      async () => {
        await tools.github_create_pull_request.execute(
          {
            title: "Publish the app",
            repository: "octocat/app",
            createRepository: false,
          },
          { messages: [], toolCallId: "call_2" } as never,
        );
      },
      /createRepository/i,
    );
  } finally {
    await sandbox.destroy();
  }
});
