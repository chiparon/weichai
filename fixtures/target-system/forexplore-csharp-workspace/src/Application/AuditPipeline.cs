using System.Security.Cryptography;
using System.Text;
using ForeXplore.Skeleton.Ports;

namespace ForeXplore.Skeleton.Application;

/// <summary>Coordinates durable audit appends and hash-chain verification.</summary>
```csharp
public sealed class AuditPipeline
{
    private readonly List<AuditRecord> records = new List<AuditRecord>();
    private readonly Clock clock;
    private string tail = "GENESIS";

    public AuditPipeline(Clock clock)
    {
        this.clock = clock;
    }

    public AuditRecord Append(string action, string subject, string payload)
    {
        lock (this)
        {
            long sequence = records.Count + 1L;
            AuditRecord candidate = new AuditRecord(sequence, action, subject, payload, tail, "", clock.Now());
            string hash = Digest(candidate.Canonical());
            AuditRecord record = new AuditRecord(sequence, action, subject, payload, tail, hash, candidate.OccurredAt());
            records.Add(record);
            tail = hash;
            return record;
        }
    }

    public bool Verify()
    {
        lock (this)
        {
            string previous = "GENESIS";
            foreach (AuditRecord record in records)
            {
                if (!previous.Equals(record.PreviousHash()) || !Digest(record.WithoutHash().Canonical()).Equals(record.Hash()))
                {
                    return false;
                }
                previous = record.Hash();
            }
            return true;
        }
    }

    public List<AuditRecord> Records()
    {
        lock (this)
        {
            return new List<AuditRecord>(records);
        }
    }

    private string Digest(string text)
    {
        try
        {
            byte[] bytes = System.Security.Cryptography.SHA256.Create().ComputeHash(System.Text.Encoding.UTF8.GetBytes(text));
            System.Text.StringBuilder value = new System.Text.StringBuilder();
            foreach (byte item in bytes)
            {
                value.Append(item.ToString("x2"));
            }
            return value.ToString();
        }
        catch (System.Security.Cryptography.CryptographicException error)
        {
            throw new InvalidOperationException(error.Message, error);
        }
    }
}
```
```
```
```
