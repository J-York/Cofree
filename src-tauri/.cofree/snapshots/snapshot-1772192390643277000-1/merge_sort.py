def merge_sort(arr):
    """
    归并排序算法实现
    时间复杂度: O(n log n)
    空间复杂度: O(n)
    """
    if len(arr) <= 1:
        return arr
    
    # 分割数组
    mid = len(arr) // 2
    left = merge_sort(arr[:mid])
    right = merge_sort(arr[mid:])
    
    # 合并两个有序数组
    return merge(left, right)


def merge(left, right):
    """
    合并两个有序数组
    """
    result = []
    i = j = 0
    
    # 比较两个数组的元素，将较小的放入结果数组
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            result.append(left[i])
            i += 1
        else:
            result.append(right[j])
            j += 1
    
    # 将剩余元素加入结果数组
    result.extend(left[i:])
    result.extend(right[j:])
    
    return result


if __name__ == "__main__":
    # 测试示例
    test_array = [38, 27, 43, 3, 9, 82, 10]
    print(f"原始数组: {test_array}")
    sorted_array = merge_sort(test_array)
    print(f"排序后: {sorted_array}")
