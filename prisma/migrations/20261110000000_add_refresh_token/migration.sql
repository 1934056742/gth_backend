-- CreateTable
-- 刷新令牌表（双 token 方案）
-- 设计要点：
--   1. userId 唯一：一个用户最多一条刷新令牌，
--      登录时先删旧记录再插新的，多端登录以最后一次为准（后登录挤掉先登录）；
--   2. tokenHash：只存刷新令牌的 sha256 摘要，不存明文，
--      即使数据库泄露也拿不到可直接使用的令牌；
--   3. expiresAt：7 天有效期，刷新时校验，过期记录顺手清理；
--   4. 用户被删除时记录级联删除（ON DELETE CASCADE），不留孤儿数据。
CREATE TABLE `RefreshToken` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `RefreshToken_userId_key`(`userId`),
    UNIQUE INDEX `RefreshToken_tokenHash_key`(`tokenHash`),
    INDEX `RefreshToken_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RefreshToken` ADD CONSTRAINT `RefreshToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
