<div className="filter-group">
  <label>Chủ đề</label>
  <select 
    value={filters.topic || ''} 
    onChange={(e) => setFilters({ ...filters, topic: e.target.value })}
  >
    <option value="">Tất cả chủ đề</option>
    {availableTopics.map((topic) => (
      <option key={topic.id || topic} value={topic.value || topic}>
        {topic.label || topic}
      </option>
    ))}
  </select>
</div>


<div className="filter-group">
  <label>Nguồn</label>
  <select 
    value={filters.sourceId || ''} 
    onChange={(e) => setFilters({ ...filters, sourceId: e.target.value })}
  >
    <option value="">Tất cả nguồn</option>
  </select>
</div>
