import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { initDb, closeDb } from "../src/db.js";
import { NotificationRepository } from "../src/repositories/notificationRepository.js";
import { UserRepository } from "../src/repositories/userRepository.js";

afterEach(() => closeDb());

test("notifications fan out to active users and support read state", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const notificationRepo = new NotificationRepository(db);
  const sender = userRepo.create({ username: "notify-sender", passwordHash: "p" });
  const recipient = userRepo.create({ username: "notify-recipient", passwordHash: "p" });
  const blocked = userRepo.create({ username: "notify-blocked", passwordHash: "p" });
  userRepo.updateStatus(blocked.id, "blocked");

  const sent = notificationRepo.createForActiveUsers({
    title: "Bảo trì hệ thống",
    body: "Jukebox sẽ được cập nhật lúc 22:00.",
    kind: "maintenance",
    createdByUserId: sender.id,
  });

  assert.equal(sent.recipientCount, 2);
  assert.deepEqual(sent.notification, {
    id: sent.notification.id,
    title: "Bảo trì hệ thống",
    body: "Jukebox sẽ được cập nhật lúc 22:00.",
    kind: "maintenance",
    createdAt: sent.notification.createdAt,
  });

  const initial = notificationRepo.listForUser(recipient.id, { limit: 20 });
  assert.equal(initial.total, 1);
  assert.equal(initial.unreadCount, 1);
  assert.equal(initial.items[0].read, false);
  assert.equal(initial.items[0].readAt, null);

  assert.equal(notificationRepo.markRead(sent.notification.id, recipient.id), true);
  assert.equal(notificationRepo.markRead(sent.notification.id, recipient.id), false);
  const afterRead = notificationRepo.listForUser(recipient.id);
  assert.equal(afterRead.unreadCount, 0);
  assert.equal(afterRead.items[0].read, true);
  assert.ok(afterRead.items[0].readAt);

  const lateUser = userRepo.create({ username: "notify-late", passwordHash: "p" });
  assert.equal(notificationRepo.listForUser(lateUser.id).total, 0);
  assert.equal(notificationRepo.listForUser(blocked.id).total, 0);

  const second = notificationRepo.createForActiveUsers({
    title: "Tính năng mới",
    body: "Đã cập nhật bảng xếp hạng.",
    kind: "feature",
    createdByUserId: sender.id,
  });
  assert.equal(second.recipientCount, 3);
  assert.equal(notificationRepo.listForUser(recipient.id).unreadCount, 1);
  assert.equal(notificationRepo.markAllRead(recipient.id), 1);
  assert.equal(notificationRepo.markAllRead(recipient.id), 0);
  assert.equal(notificationRepo.getUnreadCount(recipient.id), 0);
});

test("notification history is newest-first and bounded to twenty items", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const notificationRepo = new NotificationRepository(db);
  const user = userRepo.create({ username: "notify-history", passwordHash: "p" });

  for (let index = 0; index < 21; index += 1) {
    notificationRepo.createForActiveUsers({
      title: `Thông báo ${index}`,
      body: "Nội dung thông báo",
      createdByUserId: user.id,
    });
  }

  const result = notificationRepo.listForUser(user.id, { limit: 200 });
  assert.equal(result.total, 21);
  assert.equal(result.items.length, 20);
  assert.equal(result.unreadCount, 21);
  assert.equal(result.items[0].title, "Thông báo 20");
  assert.equal(result.items.at(-1).title, "Thông báo 1");
  assert.equal(Object.hasOwn(result.items[0], "createdByUserId"), false);
});

test("admin notification history exposes delivery and read counts", () => {
  const db = initDb({ dbPath: ":memory:" });
  const userRepo = new UserRepository(db);
  const notificationRepo = new NotificationRepository(db);
  const admin = userRepo.create({ username: "notify-admin", passwordHash: "p", role: "admin" });
  const user = userRepo.create({ username: "notify-history-user", passwordHash: "p" });

  const sent = notificationRepo.createForActiveUsers({
    title: "Thông báo quản trị",
    body: "Kiểm tra tính năng mới.",
    createdByUserId: admin.id,
  });
  notificationRepo.markRead(sent.notification.id, user.id);

  const result = notificationRepo.listAdmin({ limit: 20 });
  assert.equal(result.total, 1);
  assert.deepEqual(result.items[0], {
    id: sent.notification.id,
    title: "Thông báo quản trị",
    body: "Kiểm tra tính năng mới.",
    kind: "info",
    createdAt: sent.notification.createdAt,
    createdByDisplayName: admin.display_name,
    recipientCount: 2,
    readCount: 1,
  });
});
