// Return true if the message appears to be an image reply (attachment, embed image, or image URL)
export function isImageMessage(msg: any): boolean {
  try {
    if (msg.attachments && msg.attachments.size > 0) {
      for (const att of msg.attachments.values()) {
        const ct = (att.contentType as string) || "";
        if (ct.startsWith("image/")) return true;
        const name = att.name || att.url || "";
        if (/(\.png|\.jpe?g|\.gif|\.webp|\.bmp|\.tiff|\.svg|\.webp)$/i.test(name)) return true;
      }
    }
    if (msg.embeds && msg.embeds.length > 0) {
      for (const e of msg.embeds) {
      if (e.image?.url || e.thumbnail?.url) return true;
      if (e.type === "image" && e.url) return true;
      }
    }
    if (typeof msg.content === "string" && msg.content) {
      const urlRegex = /(https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp|tiff|svg|webp))(?:\?\S*)?/i;
      if (urlRegex.test(msg.content)) return true;
    }
    } catch (e) {
    // If anything goes wrong, be conservative and treat as non-image
    }
    return false;
  }


  export function buildRulesMessage(): string {
    const now = new Date();
    const utcTomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dateStr = utcTomorrow.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
    });
    
    // Discord timestamp for 4am UTC tomorrow
    const tomorrow4amUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 4, 0, 0));
    const timestamp = Math.floor(tomorrow4amUTC.getTime() / 1000);
    
    return (
    `Welcome to the daily drawing thread for ${dateStr}!\n` +
    "- Please only post images in this thread\n" +
    "- React an image with \\:fire\\: :fire: to vote for it to win, you may vote as much as you'd like\n" +
    "- If your drawing went over time, react on it with \\:timer\\: :timer: and it won't be counted\n" +
    "- You can post multiple drawings, just keep them as separate replies in the thread\n" +
    `- The deadline is: 04:00 UTC / <t:${timestamp}:t> your local time\n`
    );
  }