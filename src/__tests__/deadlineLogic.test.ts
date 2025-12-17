import { describe, it, expect, vi } from "vitest";
import { calculateTopThreeDrawings } from "../deadlineLogic";
import { ChannelType } from "discord.js";

// Mock reaction helpers to return deterministic counts and no overtime
vi.mock("../reactionCheck", () => {
  return {
    isMarkedOvertime: vi.fn(async () => false),
    countFireReactors: vi.fn(async (reply: any) => {
      const counts: Record<string, number> = { u1: 5, u2: 4, u3: 3, u4: 2, u5: 1 };
      return counts[reply.author.id] ?? 0;
    }),
  };
});

describe("calculateTopThreeDrawings", () => {
  it("returns the top three artists from five image submissions with different fire reacts", async () => {
    const forumChannelName = "drawings";

    // Five image replies
    const replies = [
      { id: "m1", author: { id: "u1", username: "Alice" }, content: "https://example.com/a.png", reactions: { cache: new Map() } },
      { id: "m2", author: { id: "u2", username: "Bob" }, content: "https://example.com/b.png", reactions: { cache: new Map() } },
      { id: "m3", author: { id: "u3", username: "Cathy" }, content: "https://example.com/c.png", reactions: { cache: new Map() } },
      { id: "m4", author: { id: "u4", username: "Dan" }, content: "https://example.com/d.png", reactions: { cache: new Map() } },
      { id: "m5", author: { id: "u5", username: "Eve" }, content: "https://example.com/e.png", reactions: { cache: new Map() } },
    ];

    // The original post (should be excluded)
    const post = { id: "post", author: { id: "op", username: "OP" }, content: "Original thread post", reactions: { cache: new Map() } };

    // Build messages Map so that replies come first and post is last (the function excludes the last message)
    const messagesMap = new Map<string, any>();
    for (const r of replies) messagesMap.set(r.id, r);
    messagesMap.set(post.id, post);

    const thread = {
      id: "thread1",
      createdTimestamp: Date.now(),
      messages: { fetch: async () => ({ values: () => messagesMap.values(), // collection-like object with values()
      }) },
    };

    const forumChannel = {
      type: ChannelType.GuildForum,
      name: forumChannelName,
      threads: { fetchActive: async () => ({ threads: new Map([[thread.id, thread]]) }) },
    };

    // Emulate discord.js Collection with a 'find' method
    const guild = { channels: { cache: { find: (predicate: any) => (predicate(forumChannel) ? forumChannel : undefined) } } } as any;

    const top = await calculateTopThreeDrawings(guild, forumChannelName);

    expect(top.length).toBe(3);
    expect(top[0]).toEqual({ id: "u1", username: "Alice", votes: 5 });
    expect(top[1]).toEqual({ id: "u2", username: "Bob", votes: 4 });
    expect(top[2]).toEqual({ id: "u3", username: "Cathy", votes: 3 });
  });
});
