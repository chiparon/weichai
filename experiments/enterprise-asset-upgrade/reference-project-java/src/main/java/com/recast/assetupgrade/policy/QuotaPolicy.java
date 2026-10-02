package com.recast.assetupgrade.policy;

import com.recast.assetupgrade.domain.AttachmentInput;
import com.recast.assetupgrade.domain.OrderRequest;

public final class QuotaPolicy {
    private final int maxAttachmentBytes;
    private final int maxOrderLines;
    private final long maxOrderItems;

    public QuotaPolicy(int maxAttachmentBytes, int maxOrderLines, long maxOrderItems) {
        if (maxAttachmentBytes <= 0 || maxOrderLines <= 0 || maxOrderItems <= 0) {
            throw new IllegalArgumentException("quota values must be positive");
        }
        this.maxAttachmentBytes = maxAttachmentBytes;
        this.maxOrderLines = maxOrderLines;
        this.maxOrderItems = maxOrderItems;
    }

    public static QuotaPolicy defaults() { return new QuotaPolicy(10 * 1024 * 1024, 100, 10_000); }
    public boolean attachmentFits(AttachmentInput input) { return input != null && input.content().length <= maxAttachmentBytes; }
    public boolean orderFits(OrderRequest order) {
        return order != null && order.lines().size() <= maxOrderLines
                && com.recast.assetupgrade.domain.OrderTotals.from(order.lines()).itemCount() <= maxOrderItems;
    }
    public int maxAttachmentBytes() { return maxAttachmentBytes; }
    public int maxOrderLines() { return maxOrderLines; }
    public long maxOrderItems() { return maxOrderItems; }
}
