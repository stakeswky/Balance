import assert from "node:assert/strict";
import test from "node:test";
import { chooseRepositoryDirectory } from "./folder-picker.ts";

test("repository folder picker requests one local directory and applies the selection", async () => {
  const events: string[] = [];
  let repositoryPath = "/tmp/existing-project";

  await chooseRepositoryDirectory({
    picker: async (options) => {
      assert.deepEqual(options, {
        title: "选择本地 Git 仓库文件夹",
        directory: true,
        multiple: false,
      });
      return "/tmp/selected-project";
    },
    onChoosingChange: (choosing) => events.push(`choosing:${choosing}`),
    onPathSelected: (path) => {
      repositoryPath = path;
      events.push(`path:${path}`);
    },
    onError: (error) => events.push(`error:${error ?? "none"}`),
  });

  assert.equal(repositoryPath, "/tmp/selected-project");
  assert.deepEqual(events, [
    "choosing:true",
    "error:none",
    "path:/tmp/selected-project",
    "choosing:false",
  ]);
});

test("repository folder picker keeps the current path when the user cancels", async () => {
  const events: string[] = [];
  let repositoryPath = "/tmp/existing-project";

  await chooseRepositoryDirectory({
    picker: async () => null,
    onChoosingChange: (choosing) => events.push(`choosing:${choosing}`),
    onPathSelected: (path) => {
      repositoryPath = path;
    },
    onError: (error) => events.push(`error:${error ?? "none"}`),
  });

  assert.equal(repositoryPath, "/tmp/existing-project");
  assert.deepEqual(events, ["choosing:true", "error:none", "choosing:false"]);
});

test("repository folder picker keeps the current path and reports Chinese error on failure", async () => {
  const events: string[] = [];
  let repositoryPath = "/tmp/existing-project";

  await chooseRepositoryDirectory({
    picker: async () => {
      throw new Error("native dialog unavailable");
    },
    onChoosingChange: (choosing) => events.push(`choosing:${choosing}`),
    onPathSelected: (path) => {
      repositoryPath = path;
    },
    onError: (error) => events.push(`error:${error ?? "none"}`),
  });

  assert.equal(repositoryPath, "/tmp/existing-project");
  assert.deepEqual(events, [
    "choosing:true",
    "error:none",
    "error:选择文件夹失败，请确认 Balance 有权访问本机文件后重试",
    "choosing:false",
  ]);
});
