ALTER TABLE "canonical_item" ADD COLUMN "search_vector" "tsvector" DEFAULT ''::tsvector NOT NULL;--> statement-breakpoint
UPDATE "canonical_item" AS item
SET "search_vector" =
	setweight(to_tsvector('simple', coalesce(item."title", '')), 'A')
	|| setweight(to_tsvector('simple', coalesce(item."original_title", '')), 'B')
	|| setweight(
		to_tsvector(
			'simple',
			coalesce(
				(
					SELECT string_agg(credit."name", ' ' ORDER BY credit."display_order")
					FROM "canonical_credit" AS credit
					WHERE credit."canonical_item_id" = item."id"
						AND credit."role" = 'actor'
				),
				''
			)
		),
		'C'
	)
	|| setweight(to_tsvector('simple', array_to_string(item."genres", ' ')), 'D');--> statement-breakpoint
CREATE INDEX "canonical_item_search_vector_index" ON "canonical_item" USING gin ("search_vector");