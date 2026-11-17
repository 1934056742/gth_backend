-- CreateTable
-- 知识库文档（RAG）
-- 设计要点：
--   1. 与「文件上传」页的附件互不影响：那张表是一般附件，这里专门喂给 AI 答疑；
--   2. content 存解析后的纯文本全文：切块是派生的，以后调整切块策略可以直接重建，
--      不必再让用户重新上传原文件；
--   3. chunkCount 冗余存一份，列表页不用 count 子表；
--   4. ownerId 外键 ON DELETE CASCADE：用户被删时文档一并清理，不留孤儿数据。
CREATE TABLE `KnowledgeDoc` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ownerId` INTEGER NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `fileSize` INTEGER NOT NULL DEFAULT 0,
    `content` TEXT NOT NULL,
    `charCount` INTEGER NOT NULL DEFAULT 0,
    `chunkCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `KnowledgeDoc_ownerId_createdAt_idx`(`ownerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
-- 知识库切块：检索的最小单位
-- tokens 存分词结果（空格分隔），检索时直接做词频统计，避免每次提问都重新分词；
-- tokenCount 预先算好，BM25 的文档长度归一化直接用它。
CREATE TABLE `KnowledgeChunk` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `docId` INTEGER NOT NULL,
    `seq` INTEGER NOT NULL,
    `content` TEXT NOT NULL,
    `tokens` TEXT NOT NULL,
    `tokenCount` INTEGER NOT NULL DEFAULT 0,

    INDEX `KnowledgeChunk_docId_seq_idx`(`docId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `KnowledgeDoc` ADD CONSTRAINT `KnowledgeDoc_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KnowledgeChunk` ADD CONSTRAINT `KnowledgeChunk_docId_fkey` FOREIGN KEY (`docId`) REFERENCES `KnowledgeDoc`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
