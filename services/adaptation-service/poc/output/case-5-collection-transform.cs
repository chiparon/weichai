public Dictionary<string, decimal> CalculateCategoryTotals(List<Order> orders)
{
    var totals = new Dictionary<string, decimal>();
    foreach (var order in orders)
    {
        foreach (var item in order.Items)
        {
            string category = item.Category;
            decimal amount = item.Price * item.Quantity;
            decimal existing;
            if (totals.TryGetValue(category, out existing))
            {
                totals[category] = existing + amount;
            }
            else
            {
                totals[category] = amount;
            }
        }
    }
    return totals
        .OrderByDescending(kvp => kvp.Value)
        .Take(10)
        .ToDictionary(kvp => kvp.Key, kvp => kvp.Value);
}
