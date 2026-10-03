namespace AssetUpgradeGateway.Policies;

using AssetUpgradeGateway;
using AssetUpgradeGateway.Domain;
using System.Text;

public sealed record AttachmentPolicyOptions(
    long MaximumBytes,
    IReadOnlySet<string> AllowedExtensions,
    IReadOnlySet<string> AllowedContentTypes,
    IReadOnlySet<string> BlockedFileNames,
    int MaximumNameLength,
    bool RequireScan)
{
    public static AttachmentPolicyOptions Default { get; } = new(
        25 * 1024 * 1024,
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".pdf", ".txt", ".csv", ".json", ".zip", ".png", ".jpg" },
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "application/pdf", "text/plain", "text/csv", "application/json", "application/zip", "image/png", "image/jpeg" },
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "con", "nul", "desktop.ini" },
        180,
        true);
}

public sealed class FilenameSafetyPolicy
{
    private static readonly char[] Dangerous = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    private readonly AttachmentPolicyOptions options;
    public FilenameSafetyPolicy(AttachmentPolicyOptions? options = null) => this.options = options ?? AttachmentPolicyOptions.Default;

    public PolicyResult Evaluate(string? fileName)
    {
        var issues = new List<ValidationIssue>();
        if (string.IsNullOrWhiteSpace(fileName))
            issues.Add(new("attachment.filename.empty", "A file name is required.", ValidationSeverity.Error));
        else
        {
            if (fileName.Length > options.MaximumNameLength)
                issues.Add(new("attachment.filename.length", "The file name exceeds the configured length.", ValidationSeverity.Error));
            if (fileName.Any(char.IsControl) || fileName.IndexOfAny(Dangerous) >= 0)
                issues.Add(new("attachment.filename.characters", "The file name contains a path or control character.", ValidationSeverity.Error));
            if (fileName is "." or ".." || options.BlockedFileNames.Contains(fileName))
                issues.Add(new("attachment.filename.reserved", "The file name is reserved.", ValidationSeverity.Error));
            if (fileName.EndsWith(' ') || fileName.EndsWith('.'))
                issues.Add(new("attachment.filename.trailing", "The file name cannot end with a space or period.", ValidationSeverity.Error));
        }
        return issues.Count == 0 ? PolicyResult.Allow() : PolicyResult.Deny([.. issues]);
    }

    public string Normalize(string fileName)
    {
        var trimmed = fileName.Trim();
        var leaf = trimmed.Replace('\\', '/').Split('/').Last();
        return leaf.Normalize(NormalizationForm.FormC);
    }
}

public sealed class MimeCompatibilityPolicy
{
    private readonly AttachmentPolicyOptions options;
    public MimeCompatibilityPolicy(AttachmentPolicyOptions? options = null) => this.options = options ?? AttachmentPolicyOptions.Default;

    public PolicyResult Evaluate(string fileName, string contentType)
    {
        var issues = new List<ValidationIssue>();
        var extension = Path.GetExtension(fileName);
        if (!options.AllowedExtensions.Contains(extension))
            issues.Add(new("attachment.extension.unsupported", $"Extension '{extension}' is not supported.", ValidationSeverity.Error));
        if (!options.AllowedContentTypes.Contains(contentType))
            issues.Add(new("attachment.mime.unsupported", $"Content type '{contentType}' is not supported.", ValidationSeverity.Error));
        if (IsMismatch(extension, contentType))
            issues.Add(new("attachment.mime.mismatch", "The declared content type does not match the extension.", ValidationSeverity.Error));
        return issues.Count == 0 ? PolicyResult.Allow() : PolicyResult.Deny([.. issues]);
    }

    private static bool IsMismatch(string extension, string contentType)
        => extension.ToLowerInvariant() switch
        {
            ".pdf" => contentType != "application/pdf",
            ".json" => contentType != "application/json",
            ".csv" => contentType != "text/csv",
            ".txt" => contentType != "text/plain",
            ".zip" => contentType != "application/zip",
            ".png" => contentType != "image/png",
            ".jpg" or ".jpeg" => contentType != "image/jpeg",
            _ => true,
        };
}

public sealed class AttachmentSizePolicy
{
    private readonly AttachmentPolicyOptions options;
    public AttachmentSizePolicy(AttachmentPolicyOptions? options = null) => this.options = options ?? AttachmentPolicyOptions.Default;

    public PolicyResult Evaluate(long length)
    {
        if (length < 0) return PolicyResult.Deny(new("attachment.length.negative", "Attachment length cannot be negative.", ValidationSeverity.Error));
        if (length == 0) return PolicyResult.Deny(new("attachment.length.empty", "An empty attachment is not accepted.", ValidationSeverity.Error));
        return length <= options.MaximumBytes
            ? PolicyResult.Allow()
            : PolicyResult.Deny(new("attachment.length.limit", $"Attachment exceeds {options.MaximumBytes} bytes.", ValidationSeverity.Error));
    }
}

public sealed class ContentSignaturePolicy
{
    private static readonly IReadOnlyDictionary<string, ContentSignature> Signatures = new Dictionary<string, ContentSignature>(StringComparer.OrdinalIgnoreCase)
    {
        [".pdf"] = new("application/pdf", [0x25, 0x50, 0x44, 0x46], [".pdf"], false),
        [".zip"] = new("application/zip", [0x50, 0x4b, 0x03, 0x04], [".zip"], false),
        [".png"] = new("image/png", [0x89, 0x50, 0x4e, 0x47], [".png"], false),
        [".jpg"] = new("image/jpeg", [0xff, 0xd8, 0xff], [".jpg", ".jpeg"], false),
        [".jpeg"] = new("image/jpeg", [0xff, 0xd8, 0xff], [".jpg", ".jpeg"], false),
    };

    public PolicyResult Evaluate(string fileName, ReadOnlySpan<byte> content)
    {
        var extension = Path.GetExtension(fileName);
        if (!Signatures.TryGetValue(extension, out var signature))
            return LooksLikeText(content) ? PolicyResult.Allow() : PolicyResult.Deny(new("attachment.signature.unknown", "The content signature could not be verified.", ValidationSeverity.Warning));
        return signature.Matches(content)
            ? PolicyResult.Allow()
            : PolicyResult.Deny(new("attachment.signature.mismatch", "The file header does not match its extension.", ValidationSeverity.Error));
    }

    private static bool LooksLikeText(ReadOnlySpan<byte> content)
    {
        foreach (var value in content[..Math.Min(content.Length, 512)])
            if (value == 0 || value < 0x09 || (value > 0x7e && value != 0x0a && value != 0x0d))
                return false;
        return content.Length > 0;
    }
}

public sealed class AttachmentValidationPipeline
{
    private readonly FilenameSafetyPolicy filename;
    private readonly MimeCompatibilityPolicy mime;
    private readonly AttachmentSizePolicy size;
    private readonly ContentSignaturePolicy signature;
    public AttachmentValidationPipeline(AttachmentPolicyOptions? options = null)
    {
        filename = new(options); mime = new(options); size = new(options); signature = new();
    }

    public PolicyResult Evaluate(AttachmentInput attachment)
    {
        var issues = new List<ValidationIssue>();
        Add(issues, filename.Evaluate(attachment.FileName));
        Add(issues, mime.Evaluate(attachment.FileName, attachment.DeclaredContentType));
        Add(issues, size.Evaluate(attachment.Content.Length));
        Add(issues, signature.Evaluate(attachment.FileName, attachment.Content.Span));
        if (!attachment.Scanned)
            issues.Add(new("attachment.scan.required", "The attachment has not passed malware scanning.", ValidationSeverity.Error));
        return issues.Any(x => x.BlocksOperation) ? PolicyResult.Deny([.. issues]) : new(true, issues);
    }

    private static void Add(List<ValidationIssue> target, PolicyResult result) => target.AddRange(result.Issues);
}

public sealed class TenantAttachmentPolicy
{
    public PolicyResult Evaluate(TenantScope scope, AttachmentInput attachment, string operation)
    {
        var issues = new List<ValidationIssue>();
        if (scope.IsExpired(DateTimeOffset.UtcNow)) issues.Add(new("tenant.scope.expired", "The tenant scope has expired.", ValidationSeverity.Error));
        if (!string.Equals(scope.TenantId, attachment.TenantId, StringComparison.Ordinal)) issues.Add(new("tenant.scope.mismatch", "Attachment tenant does not match the active scope.", ValidationSeverity.Error));
        if (!scope.Can(operation)) issues.Add(new("tenant.permission.denied", $"Permission '{operation}' is required.", ValidationSeverity.Error));
        return issues.Count == 0 ? PolicyResult.Allow() : PolicyResult.Deny([.. issues]);
    }
}
