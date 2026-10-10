CREATE TABLE `design_axes` (
	`id` text PRIMARY KEY,
	`spaceId` text NOT NULL,
	`key` text NOT NULL,
	`labelZh` text NOT NULL,
	`labelEn` text DEFAULT '' NOT NULL,
	`hintZh` text DEFAULT '' NOT NULL,
	`groupKey` text DEFAULT '' NOT NULL,
	`anchorsJson` text DEFAULT '[]' NOT NULL,
	`sortOrder` integer DEFAULT 0 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	CONSTRAINT `fk_design_axes_spaceId_design_spaces_id_fk` FOREIGN KEY (`spaceId`) REFERENCES `design_spaces`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `design_spaces` (
	`id` text PRIMARY KEY,
	`code` text NOT NULL UNIQUE,
	`labelZh` text NOT NULL,
	`labelEn` text DEFAULT '' NOT NULL,
	`hintZh` text DEFAULT '' NOT NULL,
	`sortOrder` integer DEFAULT 0 NOT NULL,
	`isBuiltin` integer DEFAULT 0 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entries` (
	`id` text PRIMARY KEY,
	`domain` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`author` text DEFAULT 'unclear' NOT NULL,
	`license` text DEFAULT 'unclear' NOT NULL,
	`trainable` text DEFAULT 'unclear' NOT NULL,
	`imagePath` text DEFAULT '' NOT NULL,
	`imageSource` text DEFAULT 'file' NOT NULL,
	`originalName` text DEFAULT '' NOT NULL,
	`observed` text DEFAULT '' NOT NULL,
	`read` text DEFAULT '' NOT NULL,
	`worthwhileBecause` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending_ai' NOT NULL,
	`analysisStatus` text DEFAULT 'committed' NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	CONSTRAINT "entries_trainable_check" CHECK("trainable" IN ('yes', 'no', 'unclear', 'user-yes')),
	CONSTRAINT "entries_status_check" CHECK("status" IN ('pending_ai', 'inbox', 'reviewed'))
);
--> statement-breakpoint
CREATE TABLE `entry_axis_values` (
	`entryId` text NOT NULL,
	`spaceId` text NOT NULL,
	`axisKey` text NOT NULL,
	`value` real NOT NULL,
	`setAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	CONSTRAINT `entry_axis_values_pk` PRIMARY KEY(`entryId`, `spaceId`, `axisKey`),
	CONSTRAINT `fk_entry_axis_values_entryId_entries_id_fk` FOREIGN KEY (`entryId`) REFERENCES `entries`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_entry_axis_values_spaceId_design_spaces_id_fk` FOREIGN KEY (`spaceId`) REFERENCES `design_spaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT "entry_axis_values_value_check" CHECK("value" >= 0 AND "value" <= 1)
);
--> statement-breakpoint
CREATE TABLE `entry_tags` (
	`entryId` text NOT NULL,
	`tagId` text NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`ruleId` text DEFAULT '' NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`createdAt` text NOT NULL,
	CONSTRAINT `entry_tags_pk` PRIMARY KEY(`entryId`, `tagId`),
	CONSTRAINT `fk_entry_tags_entryId_entries_id_fk` FOREIGN KEY (`entryId`) REFERENCES `entries`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_entry_tags_tagId_tags_id_fk` FOREIGN KEY (`tagId`) REFERENCES `tags`(`id`) ON DELETE CASCADE,
	CONSTRAINT "entry_tags_confidence_check" CHECK("confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE `import_id_map` (
	`externalId` text PRIMARY KEY,
	`localId` text NOT NULL,
	`importedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monster_entries` (
	`entryId` text PRIMARY KEY,
	CONSTRAINT `fk_monster_entries_entryId_entries_id_fk` FOREIGN KEY (`entryId`) REFERENCES `entries`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `design_axes_space_key` ON `design_axes` (`spaceId`,`key`);--> statement-breakpoint
CREATE INDEX `design_axes_space_idx` ON `design_axes` (`spaceId`,`sortOrder`);--> statement-breakpoint
CREATE INDEX `entries_status_idx` ON `entries` (`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `entries_created_idx` ON `entries` (`createdAt`);--> statement-breakpoint
CREATE INDEX `entries_domain_idx` ON `entries` (`domain`,`createdAt`);--> statement-breakpoint
CREATE INDEX `entry_axis_values_idx` ON `entry_axis_values` (`spaceId`,`axisKey`,`value`);--> statement-breakpoint
CREATE INDEX `entry_tags_tag_idx` ON `entry_tags` (`tagId`,`entryId`);--> statement-breakpoint
CREATE INDEX `entry_tags_origin_idx` ON `entry_tags` (`origin`,`ruleId`);